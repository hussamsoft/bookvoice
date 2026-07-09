import gc
import os
import re
import sys
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
_model_state = {
    "status": "idle",
    "detail": "",
    "device": "unknown",
    "cuda": False,
}
_model_lock = threading.Lock()
_generate_lock = threading.Lock()

# Chunk sizes — GPU can handle larger pieces (fewer slow generate() calls).
_CHUNK_TARGET_CHARS_GPU = 480
_CHUNK_HARD_MAX_GPU = 700
_CHUNK_TARGET_CHARS_CPU = 180
_CHUNK_HARD_MAX_CPU = 260

_SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600
_SESSION_CLEANUP_INTERVAL = 3600
_last_cleanup = 0.0


def _log(msg: str) -> None:
    """Print without ever crashing on Windows cp1252/charmap consoles."""
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        try:
            enc = getattr(sys.stdout, "encoding", None) or "ascii"
            safe = str(msg).encode(enc, errors="replace").decode(enc, errors="replace")
            print(safe, flush=True)
        except Exception:
            try:
                print(str(msg).encode("ascii", errors="replace").decode("ascii"), flush=True)
            except Exception:
                pass


def _resolve_device() -> str:
    """Prefer CUDA when a real GPU build of torch is installed."""
    force = os.getenv("TTS_DEVICE", "").strip().lower()
    if force in ("cpu", "cuda", "mps"):
        if force == "cuda" and not torch.cuda.is_available():
            _log("TTS_DEVICE=cuda requested but CUDA is not available; using CPU.")
            return "cpu"
        return force
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _is_cuda_build() -> bool:
    return torch.cuda.is_available()


def _chunk_limits():
    if _is_cuda_build():
        return _CHUNK_TARGET_CHARS_GPU, _CHUNK_HARD_MAX_GPU
    return _CHUNK_TARGET_CHARS_CPU, _CHUNK_HARD_MAX_CPU


def _data_dirs():
    data_dir = os.environ.get("DATA_DIR", "data")
    voices_dir = os.path.join(data_dir, "voices")
    sessions_dir = os.path.join(data_dir, "sessions")
    os.makedirs(voices_dir, exist_ok=True)
    os.makedirs(sessions_dir, exist_ok=True)
    return data_dir, voices_dir, sessions_dir


def _estimate_max_new_tokens(text: str) -> int:
    """
    Cap speech-token generation to what the text actually needs.
    Chatterbox defaults to max_new_tokens=1000 which is far too high for short
    chunks and makes CPU generation take minutes per chunk.
    """
    n = max(1, len(text.strip()))
    # ~1.6 speech tokens per character is generous for English/Arabic TTS.
    est = int(n * 1.6) + 48
    if _is_cuda_build():
        return max(80, min(600, est))
    # CPU: keep the budget tight so a chunk finishes in a reasonable time.
    return max(64, min(320, est))


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
    """
    Resolve bundled model directory.

    Preference order:
      1. MODEL_DIR env (set by Launcher to <app>/data/models)
      2. APP_DIR/data/models
      3. Next to this package: ../data/models (dist/backend layout)
    """
    candidates = []
    model_dir_env = os.environ.get("MODEL_DIR", "").strip()
    if model_dir_env:
        candidates.append(os.path.join(model_dir_env, target_type))
    app_dir = os.environ.get("APP_DIR", "").strip()
    if app_dir:
        candidates.append(os.path.join(app_dir, "data", "models", target_type))
    candidates.append(
        os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "data", "models", target_type)
        )
    )
    # Also try cwd-relative (manual uvicorn from dist/)
    candidates.append(os.path.abspath(os.path.join("data", "models", target_type)))

    for path in candidates:
        if _has_local_model(target_type, path):
            return path
    # Return the primary expected path for error messages
    return candidates[0]


def _has_local_model(target_type: str, local_model_path: str) -> bool:
    if target_type == "en":
        return os.path.exists(os.path.join(local_model_path, "tokenizer.json"))
    return os.path.exists(os.path.join(local_model_path, "grapheme_mtl_merged_expanded_v1.json"))


def _generate_chunk(model, text: str, language_id: str, **generate_kwargs):
    """
    Call Chatterbox generate with a text-length-aware speech-token budget.
    The stock generate() hardcodes max_new_tokens=1000 which is extremely slow
    on CPU and wasteful even on GPU.
    """
    import torch.nn.functional as F

    max_new_tokens = _estimate_max_new_tokens(text)
    # CFG doubles compute (two sequences). Keep quality on GPU; speed up CPU.
    cfg_weight = generate_kwargs.get("cfg_weight")
    if cfg_weight is None:
        cfg_weight = 0.4 if _is_cuda_build() else 0.0
    temperature = generate_kwargs.get("temperature", 0.8)
    repetition_penalty = generate_kwargs.get("repetition_penalty", 1.2)
    min_p = generate_kwargs.get("min_p", 0.05)
    top_p = generate_kwargs.get("top_p", 1.0)
    exaggeration = generate_kwargs.get("exaggeration", 0.5)
    audio_prompt_path = generate_kwargs.get("audio_prompt_path")

    if audio_prompt_path:
        model.prepare_conditionals(audio_prompt_path, exaggeration=exaggeration)
    elif model.conds is None:
        raise RuntimeError("Model has no speaker conditionals; select a voice or reinstall models.")

    # Multilingual path needs language_id
    is_mtl = language_id != "en" or type(model).__name__ == "ChatterboxMultilingualTTS"

    # Normalize + tokenize
    if is_mtl:
        from chatterbox.mtl_tts import punc_norm
        text_norm = punc_norm(text)
        text_tokens = model.tokenizer.text_to_tokens(
            text_norm, language_id=language_id.lower() if language_id else None
        ).to(model.device)
    else:
        from chatterbox.tts import punc_norm
        text_norm = punc_norm(text)
        text_tokens = model.tokenizer.text_to_tokens(text_norm).to(model.device)

    if exaggeration != model.conds.t3.emotion_adv[0, 0, 0]:
        from chatterbox.models.t3.modules.cond_enc import T3Cond

        _cond = model.conds.t3
        model.conds.t3 = T3Cond(
            speaker_emb=_cond.speaker_emb,
            cond_prompt_speech_tokens=_cond.cond_prompt_speech_tokens,
            emotion_adv=exaggeration * torch.ones(1, 1, 1),
        ).to(device=model.device)

    if cfg_weight > 0.0:
        text_tokens = torch.cat([text_tokens, text_tokens], dim=0)

    sot = model.t3.hp.start_text_token
    eot = model.t3.hp.stop_text_token
    text_tokens = F.pad(text_tokens, (1, 0), value=sot)
    text_tokens = F.pad(text_tokens, (0, 1), value=eot)

    t0 = time.perf_counter()
    with torch.inference_mode():
        speech_tokens = model.t3.inference(
            t3_cond=model.conds.t3,
            text_tokens=text_tokens,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            cfg_weight=cfg_weight,
            repetition_penalty=repetition_penalty,
            min_p=min_p,
            top_p=top_p,
        )
        speech_tokens = speech_tokens[0]
        from chatterbox.models.s3tokenizer import drop_invalid_tokens

        speech_tokens = drop_invalid_tokens(speech_tokens)
        speech_tokens = speech_tokens[speech_tokens < 6561]
        speech_tokens = speech_tokens.to(model.device)

        wav, _ = model.s3gen.inference(
            speech_tokens=speech_tokens,
            ref_dict=model.conds.gen,
        )
        wav = wav.squeeze(0).detach().cpu().numpy()
        # Watermark is optional quality; skip on CPU to save time
        if _is_cuda_build() and getattr(model, "watermarker", None) is not None:
            try:
                wav = model.watermarker.apply_watermark(wav, sample_rate=model.sr)
            except Exception as e:
                _log(f"Watermark skipped: {e}")

    elapsed = time.perf_counter() - t0
    _log(
        f"[tts] chunk {len(text)} chars -> max_tokens={max_new_tokens} "
        f"cfg={cfg_weight} device={model.device} took {elapsed:.1f}s"
    )
    return torch.from_numpy(wav).unsqueeze(0)


def get_model(language_id="en"):
    global _model, _model_type
    language_id = validate_language_id(language_id)
    target_type = "en" if language_id == "en" else "multilingual"

    with _model_lock:
        if _model is not None and _model_type != target_type:
            _log(f"Switching models from {_model_type} to {target_type}. Freeing VRAM...")
            _model_state["status"] = "loading"
            _model_state["detail"] = f"Switching to {target_type} model..."
            _model = None
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        if _model is None:
            _model_state["status"] = "loading"
            _model_state["detail"] = "Searching local model..."
            device = _resolve_device()
            _model_state["device"] = device
            _model_state["cuda"] = device == "cuda"

            if device == "cpu":
                _log(
                    "WARNING: TTS is running on CPU. Generation will be VERY slow "
                    "(minutes per page). Install CUDA PyTorch for your NVIDIA GPU - "
                    "see setup_venv.bat / fix_cuda_torch.bat."
                )
                _model_state["detail"] = (
                    "Loading on CPU (slow). Install CUDA torch for GPU speed..."
                )
            else:
                _log(
                    f"TTS device: {device}"
                    + (f" ({torch.cuda.get_device_name(0)})" if device == "cuda" else "")
                )

            local_model_path = _local_model_path(target_type)
            has_local = _has_local_model(target_type, local_model_path)

            try:
                if has_local:
                    _log(
                        f"Loading {target_type} Chatterbox TTS model from local bundle: "
                        f"{local_model_path} on {device}..."
                    )
                    if target_type == "en":
                        _model = _load_local_en(local_model_path, device)
                    else:
                        _model = _load_local_mtl(local_model_path, device)
                elif target_type == "multilingual":
                    _model_state["detail"] = (
                        "Downloading multilingual TTS model for Arabic (one-time)..."
                    )
                    _log(f"Local multilingual model missing; downloading on {device}...")
                    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

                    _model = ChatterboxMultilingualTTS.from_pretrained(device)
                else:
                    error_msg = (
                        f"Local English model weights not found at: {local_model_path}."
                    )
                    _log(error_msg)
                    raise FileNotFoundError(error_msg)

                _model_type = target_type
                _model_state["status"] = "ready"
                dev_label = device.upper()
                if device == "cuda":
                    dev_label = f"CUDA ({torch.cuda.get_device_name(0)})"
                _model_state["detail"] = f"Model ready on {dev_label}."
                _log("Model loaded.")
            except Exception as e:
                _model_state["status"] = "error"
                _model_state["detail"] = str(e)
                _log(f"Model load failed: {e}")
                raise

    return _model


def _split_into_chunks(text: str) -> list[str]:
    """Split text into TTS-friendly chunks without breaking mid-word when possible."""
    target, hard = _chunk_limits()
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= hard:
        return [text]

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
        if len(sentence) > hard:
            flush()
            words = sentence.split(" ")
            buf = ""
            for word in words:
                candidate = f"{buf} {word}".strip()
                if len(candidate) > target and buf:
                    chunks.append(buf.strip())
                    buf = word
                else:
                    buf = candidate
            if buf.strip():
                chunks.append(buf.strip())
            continue

        candidate = f"{current} {sentence}".strip() if current else sentence
        if len(candidate) <= target:
            current = candidate
        else:
            flush()
            current = sentence

    flush()
    return chunks or [text[:hard]]


def _concat_wavs(wavs: list[torch.Tensor]) -> torch.Tensor:
    if len(wavs) == 1:
        return wavs[0]
    normalized = []
    for w in wavs:
        if w.dim() == 1:
            w = w.unsqueeze(0)
        normalized.append(w)
    return torch.cat(normalized, dim=-1)


def maybe_cleanup_sessions(force: bool = False) -> None:
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
                _log(f"Cleaned old session: {name}")
        except OSError as e:
            _log(f"Session cleanup skipped for {name}: {e}")


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

    chunks = _split_into_chunks(text)
    total = len(chunks)
    wav_parts: list[torch.Tensor] = []
    device = getattr(model, "device", _resolve_device())

    _log(
        f"[tts] narrate page={page_index} chars={len(text)} chunks={total} "
        f"device={device} lang={language_id}"
    )

    with _generate_lock:
        _model_state["status"] = "generating"
        for i, chunk in enumerate(chunks):
            _model_state["detail"] = (
                f"Generating audio {i + 1}/{total} on {str(device).upper()}"
                + (" (CPU - slow; install CUDA torch for GPU)" if device == "cpu" else "")
            )
            kwargs = dict(generate_kwargs)
            if i > 0:
                kwargs.pop("audio_prompt_path", None)
            part = _generate_chunk(model, chunk, language_id, **kwargs)
            if isinstance(part, torch.Tensor):
                wav_parts.append(part.detach().cpu())
            else:
                wav_parts.append(torch.as_tensor(part).cpu())

        _model_state["status"] = "ready"
        _model_state["detail"] = f"Model ready on {str(device).upper()}."

    wav = _concat_wavs(wav_parts)

    output_dir = safe_join(sessions_dir, session_id)
    os.makedirs(output_dir, exist_ok=True)

    filename = f"page_{page_index}.wav"
    output_path = safe_join(output_dir, filename)

    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    ta.save(output_path, wav, model.sr)

    return f"/sessions/{session_id}/{filename}"
