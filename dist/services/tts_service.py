import gc
import os
import re
import threading
import time
from pathlib import Path

import torch
import torchaudio as ta

from services.path_utils import (
    safe_join,
    validate_language_id,
    validate_page_index,
    validate_session_id,
    validate_text_length,
    validate_voice_id,
)

_model = None
_model_type = None
_model_state = {"status": "idle", "detail": ""}
_model_lock = threading.Lock()
_generate_lock = threading.Lock()

# Rough speech budget per Chatterbox generate call (speech tokens ~ limited).
_CHUNK_TARGET_CHARS = 280
_CHUNK_HARD_MAX = 420
_SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600
_SESSION_CLEANUP_INTERVAL = 3600
_last_cleanup = 0.0


def _data_dirs():
    data_dir = os.environ.get("DATA_DIR", "data")
    voices_dir = os.path.join(data_dir, "voices")
    sessions_dir = os.path.join(data_dir, "sessions")
    os.makedirs(voices_dir, exist_ok=True)
    os.makedirs(sessions_dir, exist_ok=True)
    return data_dir, voices_dir, sessions_dir


def _load_local_en(ckpt_dir, device):
    from chatterbox.tts import ChatterboxTTS, Conditionals
    from chatterbox.models.voice_encoder import VoiceEncoder
    from chatterbox.models.t3 import T3
    from chatterbox.models.s3gen import S3Gen
    from chatterbox.models.tokenizers import EnTokenizer
    from safetensors.torch import load_file

    ckpt_dir = Path(ckpt_dir)
    map_location = torch.device("cpu") if device in ["cpu", "mps"] else None

    _model_state["detail"] = "Loading Voice Encoder..."
    ve = VoiceEncoder()
    ve.load_state_dict(load_file(ckpt_dir / "ve.safetensors"))
    ve.to(device).eval()

    _model_state["detail"] = "Loading T3 neural decoder (2.1GB)..."
    t3 = T3()
    t3_state = load_file(ckpt_dir / "t3_cfg.safetensors")
    if "model" in t3_state.keys():
        t3_state = t3_state["model"][0]
    t3.load_state_dict(t3_state)
    t3.to(device).eval()

    _model_state["detail"] = "Loading S3Gen audio decoder (1.0GB)..."
    s3gen = S3Gen()
    s3gen.load_state_dict(load_file(ckpt_dir / "s3gen.safetensors"), strict=False)
    s3gen.to(device).eval()

    _model_state["detail"] = "Initializing Text Tokenizer..."
    tokenizer = EnTokenizer(str(ckpt_dir / "tokenizer.json"))

    conds = None
    if (builtin_voice := ckpt_dir / "conds.pt").exists():
        _model_state["detail"] = "Loading default speaker prompt..."
        conds = Conditionals.load(builtin_voice, map_location=map_location).to(device)

    return ChatterboxTTS(t3, s3gen, ve, tokenizer, device, conds=conds)


def _load_local_mtl(ckpt_dir, device):
    from chatterbox.mtl_tts import (
        ChatterboxMultilingualTTS,
        Conditionals,
        _resolve_multilingual_t3_model,
    )
    from chatterbox.models.voice_encoder import VoiceEncoder
    from chatterbox.models.t3 import T3
    from chatterbox.models.t3.modules.t3_config import T3Config
    from chatterbox.models.s3gen import S3Gen
    from chatterbox.models.tokenizers import MTLTokenizer
    from safetensors.torch import load_file as load_safetensors

    ckpt_dir = Path(ckpt_dir)
    t3_model = _resolve_multilingual_t3_model(None)
    map_location = torch.device("cpu") if device in ["cpu", "mps"] else None

    # Prefer safetensors names used by some bundles; fall back to .pt from HF snapshot.
    ve_path = ckpt_dir / "ve.pt"
    if not ve_path.exists() and (ckpt_dir / "ve.safetensors").exists():
        ve_path = ckpt_dir / "ve.safetensors"

    s3_path = ckpt_dir / "s3gen.pt"
    if not s3_path.exists() and (ckpt_dir / "s3gen.safetensors").exists():
        s3_path = ckpt_dir / "s3gen.safetensors"

    _model_state["detail"] = "Loading Voice Encoder (multilingual)..."
    ve = VoiceEncoder()
    if ve_path.suffix == ".safetensors":
        ve.load_state_dict(load_safetensors(ve_path))
    else:
        ve.load_state_dict(torch.load(ve_path, map_location=map_location, weights_only=True))
    ve.to(device).eval()

    _model_state["detail"] = "Loading Multilingual T3 decoder (2.1GB)..."
    t3 = T3(T3Config.multilingual())
    t3_state = load_safetensors(ckpt_dir / t3_model)
    if "model" in t3_state.keys():
        t3_state = t3_state["model"][0]
    t3.load_state_dict(t3_state)
    t3.to(device).eval()

    _model_state["detail"] = "Loading S3Gen audio decoder (1.0GB)..."
    s3gen = S3Gen()
    if s3_path.suffix == ".safetensors":
        s3gen.load_state_dict(load_safetensors(s3_path), strict=False)
    else:
        s3gen.load_state_dict(torch.load(s3_path, map_location=map_location, weights_only=True))
    s3gen.to(device).eval()

    _model_state["detail"] = "Initializing Multilingual Tokenizer..."
    tokenizer = MTLTokenizer(str(ckpt_dir / "grapheme_mtl_merged_expanded_v1.json"))

    conds = None
    if (builtin_voice := ckpt_dir / "conds.pt").exists():
        _model_state["detail"] = "Loading default speaker prompt..."
        conds = Conditionals.load(builtin_voice, map_location=map_location).to(device)

    return ChatterboxMultilingualTTS(t3, s3gen, ve, tokenizer, device, conds=conds)


def _local_model_path(target_type: str) -> str:
    return os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "data", "models", target_type)
    )


def _has_local_model(target_type: str, local_model_path: str) -> bool:
    if target_type == "en":
        return os.path.exists(os.path.join(local_model_path, "tokenizer.json"))
    return os.path.exists(os.path.join(local_model_path, "grapheme_mtl_merged_expanded_v1.json"))


def get_model(language_id="en"):
    global _model, _model_type
    language_id = validate_language_id(language_id)
    # English uses the dedicated EN model; Arabic uses the multilingual model.
    target_type = "en" if language_id == "en" else "multilingual"

    with _model_lock:
        if _model is not None and _model_type != target_type:
            print(f"Switching models from {_model_type} to {target_type}. Freeing VRAM...")
            _model_state["status"] = "loading"
            _model_state["detail"] = f"Switching to {target_type} model..."
            _model = None
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        if _model is None:
            _model_state["status"] = "loading"
            _model_state["detail"] = "Searching local model..."
            device = "cuda" if torch.cuda.is_available() else "cpu"
            local_model_path = _local_model_path(target_type)
            has_local = _has_local_model(target_type, local_model_path)

            try:
                if has_local:
                    print(
                        f"Loading {target_type} Chatterbox TTS model from local bundle: "
                        f"{local_model_path} on {device}..."
                    )
                    if target_type == "en":
                        _model = _load_local_en(local_model_path, device)
                    else:
                        _model = _load_local_mtl(local_model_path, device)
                elif target_type == "multilingual":
                    # Arabic requires multilingual weights; download once from Hugging Face.
                    _model_state["detail"] = (
                        "Downloading multilingual TTS model for Arabic (one-time, several GB)..."
                    )
                    print(f"Local multilingual model missing; downloading via from_pretrained on {device}...")
                    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

                    _model = ChatterboxMultilingualTTS.from_pretrained(device)
                else:
                    error_msg = (
                        f"Local English model weights not found at: {local_model_path}. "
                        "Internet download fallback is disabled for English."
                    )
                    print(error_msg)
                    raise FileNotFoundError(error_msg)

                _model_type = target_type
                _model_state["status"] = "ready"
                _model_state["detail"] = "Model loaded successfully."
                print("Model loaded.")
            except Exception as e:
                _model_state["status"] = "error"
                _model_state["detail"] = str(e)
                print(f"Model load failed: {e}")
                raise

    return _model


def _split_into_chunks(text: str) -> list[str]:
    """Split text into TTS-friendly chunks without breaking mid-word when possible."""
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= _CHUNK_HARD_MAX:
        return [text]

    # Prefer sentence boundaries; fall back to clauses / words.
    sentences = re.split(r"(?<=[.!?؟。])\s+", text)
    chunks: list[str] = []
    current = ""

    def flush():
        nonlocal current
        if current.strip():
            chunks.append(current.strip())
        current = ""

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > _CHUNK_HARD_MAX:
            flush()
            # Hard-split long run-on sentence.
            words = sentence.split(" ")
            buf = ""
            for word in words:
                candidate = f"{buf} {word}".strip()
                if len(candidate) > _CHUNK_TARGET_CHARS and buf:
                    chunks.append(buf.strip())
                    buf = word
                else:
                    buf = candidate
            if buf.strip():
                chunks.append(buf.strip())
            continue

        candidate = f"{current} {sentence}".strip() if current else sentence
        if len(candidate) <= _CHUNK_TARGET_CHARS:
            current = candidate
        else:
            flush()
            current = sentence

    flush()
    return chunks or [text[:_CHUNK_HARD_MAX]]


def _concat_wavs(wavs: list[torch.Tensor]) -> torch.Tensor:
    if len(wavs) == 1:
        return wavs[0]
    # Normalize to 2D [channels, samples]
    normalized = []
    for w in wavs:
        if w.dim() == 1:
            w = w.unsqueeze(0)
        normalized.append(w)
    return torch.cat(normalized, dim=-1)


def maybe_cleanup_sessions(force: bool = False) -> None:
    """Delete session audio older than SESSION_MAX_AGE_SECONDS."""
    global _last_cleanup
    now = time.time()
    if not force and (now - _last_cleanup) < _SESSION_CLEANUP_INTERVAL:
        return
    _last_cleanup = now

    _, _, sessions_dir = _data_dirs()
    if not os.path.isdir(sessions_dir):
        return

    for name in os.listdir(sessions_dir):
        path = os.path.join(sessions_dir, name)
        try:
            if not os.path.isdir(path):
                continue
            mtime = os.path.getmtime(path)
            if now - mtime > _SESSION_MAX_AGE_SECONDS:
                for root, dirs, files in os.walk(path, topdown=False):
                    for f in files:
                        os.remove(os.path.join(root, f))
                    for d in dirs:
                        os.rmdir(os.path.join(root, d))
                os.rmdir(path)
                print(f"Cleaned old session: {name}")
        except OSError as e:
            print(f"Session cleanup skipped for {name}: {e}")


def narrate_text(text, session_id, page_index, voice_id=None, language_id="en"):
    text = validate_text_length(text)
    session_id = validate_session_id(session_id)
    page_index = validate_page_index(page_index)
    language_id = validate_language_id(language_id)

    maybe_cleanup_sessions()

    model = get_model(language_id)
    _, voices_dir, sessions_dir = _data_dirs()

    audio_prompt_path = None
    if voice_id:
        safe_id = validate_voice_id(
            "".join(c for c in voice_id if c.isalnum() or c in ("-", "_")).strip()
        )
        audio_prompt_path = safe_join(voices_dir, f"{safe_id}.wav")
        if not os.path.exists(audio_prompt_path):
            raise FileNotFoundError(f"Voice profile '{safe_id}' not found.")

    generate_kwargs = {}
    if audio_prompt_path:
        generate_kwargs["audio_prompt_path"] = audio_prompt_path
    if language_id != "en":
        generate_kwargs["language_id"] = language_id

    chunks = _split_into_chunks(text)
    total = len(chunks)
    wav_parts: list[torch.Tensor] = []

    # Serialize all generate calls so conditionals mutations never race.
    with _generate_lock:
        for i, chunk in enumerate(chunks):
            _model_state["detail"] = f"Generating audio chunk {i + 1}/{total}..."
            # Only pass voice prompt on first chunk; later chunks reuse model conds.
            kwargs = dict(generate_kwargs)
            if i > 0:
                kwargs.pop("audio_prompt_path", None)
            part = model.generate(chunk, **kwargs)
            if isinstance(part, torch.Tensor):
                wav_parts.append(part.detach().cpu())
            else:
                wav_parts.append(torch.as_tensor(part).cpu())

    wav = _concat_wavs(wav_parts)

    output_dir = safe_join(sessions_dir, session_id)
    os.makedirs(output_dir, exist_ok=True)

    filename = f"page_{page_index}.wav"
    output_path = safe_join(output_dir, filename)

    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    ta.save(output_path, wav, model.sr)

    _model_state["status"] = "ready"
    _model_state["detail"] = "Model loaded successfully."

    return f"/sessions/{session_id}/{filename}"
