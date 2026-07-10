import gc
import hashlib
import os
import re
import sys
import threading
import time
import uuid
from concurrent.futures import Future
from enum import IntEnum
from pathlib import Path
from queue import PriorityQueue

import torch
import torchaudio as ta

from services.config_service import config_value
from services.path_utils import (
    safe_join,
    validate_language_id,
    validate_page_index,
    validate_session_id,
    validate_text_length,
    validate_voice_id,
)

# Priority levels for TTS jobs (lower number = higher priority).
class TtsPriority(IntEnum):
    INTERACTIVE = 0  # word pronounce, voice-switch partials
    CURRENT = 1      # active page narration
    PREFETCH = 2     # background prefetch


_tts_job_queue: PriorityQueue | None = None
_tts_queue_lock = threading.Lock()
_tts_seq = 0
_tts_worker_started = False


def _next_tts_seq() -> int:
    global _tts_seq
    with _tts_queue_lock:
        _tts_seq += 1
        return _tts_seq


def _tts_queue_worker() -> None:
    while True:
        _priority, _seq, fn, args, kwargs, future = _tts_job_queue.get()  # type: ignore[union-attr]
        try:
            if not future.cancelled():
                result = fn(*args, **kwargs)
                future.set_result(result)
        except Exception as exc:
            if not future.cancelled():
                future.set_exception(exc)
        finally:
            _tts_job_queue.task_done()  # type: ignore[union-attr]


def _ensure_tts_worker() -> None:
    global _tts_job_queue, _tts_worker_started
    with _tts_queue_lock:
        if _tts_worker_started:
            return
        _tts_job_queue = PriorityQueue()
        threading.Thread(target=_tts_queue_worker, name="tts-priority", daemon=True).start()
        _tts_worker_started = True


def submit_tts(priority: TtsPriority, fn, *args, **kwargs) -> Future:
    """Submit a TTS job with priority (lower = sooner). Returns a Future."""
    _ensure_tts_worker()
    future: Future = Future()
    seq = _next_tts_seq()
    _tts_job_queue.put((int(priority), seq, fn, args, kwargs, future))  # type: ignore[union-attr]
    return future

_model = None
_model_type = None
_model_state = {
    "status": "idle",
    "detail": "",
    "device": "unknown",
    "cuda": False,
    "loading_started": None,
}
_model_lock = threading.Lock()
_generate_lock = threading.Lock()
# Avoid re-running expensive prepare_conditionals for the same voice prompt
# across consecutive chunks / narrate calls (big win on voice switch).
_last_voice_prompt: str | None = None
_last_voice_exaggeration: float | None = None

# Cooperative generation cancellation: bumped on page change / voice switch /
# document close so an in-flight multi-chunk synthesis can abort at the next
# chunk boundary instead of blocking newer work.
_generation_token = 0
_generation_lock = threading.Lock()


class GenerationCancelled(RuntimeError):
    """Raised when a synthesis is superseded by a newer generation."""


def bump_generation() -> int:
    """Invalidate all in-flight generations; returns the new token value."""
    global _generation_token
    with _generation_lock:
        _generation_token += 1
        return _generation_token


def _current_generation() -> int:
    with _generation_lock:
        return _generation_token

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
    if not force or force == "auto":
        cfg = str(config_value("tts_device", "auto") or "auto").strip().lower()
        if cfg in ("cpu", "cuda", "mps"):
            force = cfg
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
        # Cap at the stock 1000 so long chunks are never cut off mid-sentence;
        # the estimate (not the cap) is what saves time on typical chunks.
        return max(80, min(1000, est))
    # CPU: keep the budget tight so a chunk finishes in a reasonable time.
    # 500 covers the largest CPU chunk (260 chars -> ~464 tokens estimated).
    return max(64, min(500, est))


def _load_local_en(ckpt_dir, device):
    from chatterbox.tts import ChatterboxTTS, Conditionals
    from chatterbox.models.voice_encoder import VoiceEncoder
    from chatterbox.models.t3 import T3
    from chatterbox.models.s3gen import S3Gen
    from chatterbox.models.tokenizers import EnTokenizer
    from safetensors.torch import load_file

    ckpt_dir = Path(ckpt_dir)
    map_location = torch.device("cpu") if device in ["cpu", "mps"] else None

    _model_state["detail"] = f"Loading voice encoder from {ckpt_dir.name}/…"
    ve = VoiceEncoder()
    ve.load_state_dict(load_file(ckpt_dir / "ve.safetensors"))
    ve.to(device).eval()

    # Largest step — ~2.1GB weights; can take a minute on cold disk + GPU copy.
    _model_state["detail"] = (
        f"Loading T3 neural decoder (~2.1GB) into {device.upper()}…"
    )
    t3 = T3()
    t3_state = load_file(ckpt_dir / "t3_cfg.safetensors")
    if "model" in t3_state.keys():
        t3_state = t3_state["model"][0]
    t3.load_state_dict(t3_state)
    t3.to(device).eval()

    _model_state["detail"] = (
        f"Loading S3Gen audio decoder (~1.0GB) into {device.upper()}…"
    )
    s3gen = S3Gen()
    s3gen.load_state_dict(load_file(ckpt_dir / "s3gen.safetensors"), strict=False)
    s3gen.to(device).eval()

    _model_state["detail"] = "Initializing text tokenizer…"
    tokenizer = EnTokenizer(str(ckpt_dir / "tokenizer.json"))

    conds = None
    if (builtin_voice := ckpt_dir / "conds.pt").exists():
        _model_state["detail"] = "Loading default speaker prompt…"
        conds = Conditionals.load(builtin_voice, map_location=map_location).to(device)

    return ChatterboxTTS(t3, s3gen, ve, tokenizer, device, conds=conds)


def _load_local_mtl(ckpt_dir, device):
    import chatterbox.mtl_tts as mtl_mod
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS, Conditionals
    from chatterbox.models.voice_encoder import VoiceEncoder
    from chatterbox.models.t3 import T3
    from chatterbox.models.t3.modules.t3_config import T3Config
    from chatterbox.models.s3gen import S3Gen
    from chatterbox.models.tokenizers import MTLTokenizer
    from safetensors.torch import load_file as load_safetensors

    ckpt_dir = Path(ckpt_dir)
    # Stock chatterbox-tts (0.1.x) ships a single multilingual T3 checkpoint;
    # newer forks expose a resolver. Support both.
    if hasattr(mtl_mod, "_resolve_multilingual_t3_model"):
        t3_model = mtl_mod._resolve_multilingual_t3_model(None)
    else:
        t3_model = "t3_mtl23ls_v2.safetensors"
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
    Resolve the bundled model directory. This is a local path lookup only —
    not a network search. The installer/launcher always set MODEL_DIR to
    <app>/data/models so packaged runs hit the first candidate.

    Preference order:
      1. MODEL_DIR env (set by Launcher / BookVoice.bat to <app>/data/models)
      2. APP_DIR/data/models
      3. Next to this package: ../data/models (dist layout)
      4. cwd-relative data/models (manual uvicorn)
    """
    candidates = []
    model_dir_env = os.environ.get("MODEL_DIR", "").strip()
    if model_dir_env:
        candidates.append(os.path.abspath(os.path.join(model_dir_env, target_type)))
    app_dir = os.environ.get("APP_DIR", "").strip()
    if app_dir:
        candidates.append(
            os.path.abspath(os.path.join(app_dir, "data", "models", target_type))
        )
    candidates.append(
        os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "data", "models", target_type)
        )
    )
    candidates.append(os.path.abspath(os.path.join("data", "models", target_type)))

    # De-dupe while preserving order
    seen = set()
    unique = []
    for path in candidates:
        key = path.lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)

    for path in unique:
        if _has_local_model(target_type, path):
            return path
    # Primary expected path for error messages (always MODEL_DIR when set)
    return unique[0]


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
    force_prepare = bool(generate_kwargs.get("force_prepare", False))

    global _last_voice_prompt, _last_voice_exaggeration
    if audio_prompt_path:
        same_prompt = (
            not force_prepare
            and _last_voice_prompt == audio_prompt_path
            and _last_voice_exaggeration == exaggeration
            and model.conds is not None
        )
        if not same_prompt:
            model.prepare_conditionals(audio_prompt_path, exaggeration=exaggeration)
            _last_voice_prompt = audio_prompt_path
            _last_voice_exaggeration = exaggeration
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
            _model_state["loading_started"] = time.time()
            _model = None
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        if _model is None:
            load_started = time.time()
            _model_state["status"] = "loading"
            _model_state["detail"] = "Preparing TTS engine..."
            _model_state["loading_started"] = load_started
            device = _resolve_device()
            _model_state["device"] = device
            _model_state["cuda"] = device == "cuda"

            # Resolve the known install path first so the UI never implies a
            # network "search" — packages ship models under MODEL_DIR/APP_DIR.
            local_model_path = _local_model_path(target_type)
            has_local = _has_local_model(target_type, local_model_path)
            model_hint = local_model_path if has_local else "bundled data/models"

            if device == "cpu":
                _log(
                    "WARNING: TTS is running on CPU. Generation will be VERY slow "
                    "(minutes per page). Install CUDA PyTorch for your NVIDIA GPU - "
                    "see setup_venv.bat / fix_cuda_torch.bat."
                )
                _model_state["detail"] = (
                    f"Loading model on CPU (slow) from {model_hint}…"
                )
            else:
                _log(
                    f"TTS device: {device}"
                    + (f" ({torch.cuda.get_device_name(0)})" if device == "cuda" else "")
                )
                _model_state["detail"] = (
                    f"Loading model on {device.upper()} from {model_hint}…"
                )

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
                        "Downloading multilingual TTS model for Arabic (one-time)…"
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
                _model_state["loading_started"] = None
                dev_label = device.upper()
                if device == "cuda":
                    dev_label = f"CUDA ({torch.cuda.get_device_name(0)})"
                _model_state["detail"] = f"Model ready on {dev_label}."
                _log(f"Model loaded in {time.time() - load_started:.1f}s.")
            except Exception as e:
                _model_state["status"] = "error"
                _model_state["detail"] = str(e)
                _model_state["loading_started"] = None
                _log(f"Model load failed: {e}")
                raise

    return _model


def state_snapshot() -> dict:
    """Public view of the model state, with elapsed load time while loading."""
    snap = {k: v for k, v in _model_state.items() if k != "loading_started"}
    started = _model_state.get("loading_started")
    if snap.get("status") == "loading" and started:
        snap["elapsed_s"] = int(time.time() - started)
    try:
        from services.alignment_service import alignment_mode

        snap["alignment_mode"] = alignment_mode()
    except Exception:  # noqa: BLE001 - status must never fail
        snap["alignment_mode"] = "estimate"
    return snap


def preload_model(language_id: str = "en") -> None:
    """Load the model, downgrading failures to an error state (no raise)."""
    try:
        maybe_cleanup_sessions(force=True)
        get_model(language_id)
        _log("TTS model preloaded successfully.")
    except Exception as e:  # noqa: BLE001 - surfaced via _model_state
        _model_state["status"] = "error"
        _model_state["detail"] = f"Model load failed: {e}"
        _log(f"TTS model preload failed (retry from the app or next request): {e}")


def request_reload(language_id: str = "en") -> dict:
    """Queue a model (re)load on the TTS thread unless one is already running."""
    with _model_lock:
        if _model_state["status"] not in ("error", "idle"):
            return state_snapshot()
        _model_state["status"] = "loading"
        _model_state["detail"] = "Reloading model..."
        _model_state["loading_started"] = time.time()
    # Submit outside the lock so preload_model → get_model can acquire it.
    submit_tts(TtsPriority.INTERACTIVE, preload_model, language_id)
    return state_snapshot()


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


def _synthesize_audio(
    text: str,
    session_id: str,
    filename: str,
    voice_id=None,
    language_id: str = "en",
) -> dict:
    """Core TTS synthesis; writes WAV to session dir with the given filename."""
    text = validate_text_length(text)
    session_id = validate_session_id(session_id)
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
    segment_meta: list[dict] = []
    device = getattr(model, "device", _resolve_device())
    sr = float(getattr(model, "sr", 24000) or 24000)

    _log(
        f"[tts] synthesize file={filename} chars={len(text)} chunks={total} "
        f"device={device} lang={language_id}"
    )

    with _generate_lock:
        _model_state["status"] = "generating"
        started_token = _current_generation()
        try:
            cursor_s = 0.0
            for i, chunk in enumerate(chunks):
                # Cooperative cancellation: a newer generation (page change,
                # voice switch, document close) supersedes this synthesis.
                if _current_generation() != started_token:
                    raise GenerationCancelled(
                        f"generation {started_token} superseded by {_current_generation()}"
                    )
                _model_state["detail"] = (
                    f"Generating audio {i + 1}/{total} on {str(device).upper()}"
                    + (" (CPU - slow; install CUDA torch for GPU)" if device == "cpu" else "")
                )
                kwargs = dict(generate_kwargs)
                if i > 0:
                    kwargs.pop("audio_prompt_path", None)
                elif i == 0 and audio_prompt_path:
                    kwargs["force_prepare"] = False
                part = _generate_chunk(model, chunk, language_id, **kwargs)
                if isinstance(part, torch.Tensor):
                    part = part.detach().cpu()
                else:
                    part = torch.as_tensor(part).cpu()
                if part.dim() == 1:
                    part = part.unsqueeze(0)
                samples = int(part.shape[-1])
                dur = samples / sr if sr > 0 else 0.0
                segment_meta.append(
                    {
                        "text": chunk,
                        "start_s": round(cursor_s, 4),
                        "end_s": round(cursor_s + dur, 4),
                    }
                )
                cursor_s += dur
                wav_parts.append(part)
        except GenerationCancelled:
            # Cancellation is not a failure: restore ready state and propagate.
            _model_state["status"] = "ready"
            _model_state["detail"] = f"Model ready on {str(device).upper()}."
            raise
        except Exception as e:
            _model_state["status"] = "ready"
            _model_state["detail"] = (
                f"Model ready on {str(device).upper()} "
                f"(last generation failed: {e})"
            )
            raise
        else:
            _model_state["status"] = "ready"
            _model_state["detail"] = f"Model ready on {str(device).upper()}."

    wav = _concat_wavs(wav_parts)

    output_dir = safe_join(sessions_dir, session_id)
    os.makedirs(output_dir, exist_ok=True)
    output_path = safe_join(output_dir, filename)

    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    ta.save(output_path, wav, model.sr)

    result = {
        "audio_url": f"/sessions/{session_id}/{filename}",
        "segments": segment_meta,
        "duration_s": round(float(wav.shape[-1]) / sr, 4) if sr > 0 else 0.0,
    }

    # Optional forced alignment (Whisper) for accurate word timestamps.
    try:
        from services.alignment_service import align_words

        word_timings = align_words(text, output_path, language_id)
        if word_timings:
            result["word_timings"] = word_timings
    except Exception as exc:  # noqa: BLE001 - alignment is optional; timing falls back
        _log(f"Forced alignment skipped, falling back to estimates: {exc}")

    return result


def narrate_text(
    text,
    session_id,
    page_index,
    voice_id=None,
    language_id="en",
    clip_suffix: str | None = None,
):
    session_id = validate_session_id(session_id)
    page_index = validate_page_index(page_index)
    language_id = validate_language_id(language_id)
    filename = _audio_filename(
        page_index,
        text,
        voice_id,
        language_id,
        clip_suffix,
    )

    return _synthesize_audio(text, session_id, filename, voice_id, language_id)


def _audio_filename(
    page_index: int,
    text: str,
    voice_id: str | None,
    language_id: str,
    clip_suffix: str | None,
) -> str:
    """Return an immutable filename for one narration input revision."""
    identity = "\0".join(
        (
            str(page_index),
            text,
            voice_id or "default",
            language_id,
            str(clip_suffix or ""),
        )
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    partial = ""
    if clip_suffix:
        safe_suffix = re.sub(r"[^a-zA-Z0-9_-]", "", str(clip_suffix))[:24]
        if safe_suffix:
            partial = f"_p{safe_suffix}"
    return f"page_{page_index}{partial}_{digest}.wav"


def pronounce_text(text, session_id, voice_id=None, language_id="en"):
    """Short interactive clip for word pronunciation (no page_index)."""
    session_id = validate_session_id(session_id)
    clip_id = uuid.uuid4().hex[:12]
    filename = f"clip_{clip_id}.wav"
    return _synthesize_audio(text, session_id, filename, voice_id, language_id)


def narrate_text_streaming(
    text,
    session_id,
    page_index,
    voice_id=None,
    language_id="en",
):
    """Generator yielding progressive chunk events for first-audio-early playback.

    Yields dicts of shape {"type": "chunk", "index", "total", "url", "text",
    "start_s", "end_s"} as each chunk is synthesized, then a final
    {"type": "done", "audio_url", "segments", "duration_s", "word_timings"}.
    Respects the cooperative generation token (raises GenerationCancelled).

    The per-chunk files are saved immediately; the full-page concatenated file
    is also saved at the end so the existing cache-hit path and alignment still
    work unchanged.
    """
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
    device = getattr(model, "device", _resolve_device())
    sr = float(getattr(model, "sr", 24000) or 24000)

    page_hash = hashlib.sha256(
        "\0".join((str(page_index), text, voice_id or "default", language_id)).encode("utf-8")
    ).hexdigest()[:16]

    output_dir = safe_join(sessions_dir, session_id)
    os.makedirs(output_dir, exist_ok=True)

    _log(
        f"[tts] stream file=page_{page_index}_{page_hash}.wav chars={len(text)} "
        f"chunks={total} device={device} lang={language_id}"
    )

    wav_parts: list[torch.Tensor] = []
    segment_meta: list[dict] = []
    chunk_urls: list[str] = []

    with _generate_lock:
        _model_state["status"] = "generating"
        started_token = _current_generation()
        try:
            cursor_s = 0.0
            for i, chunk in enumerate(chunks):
                if _current_generation() != started_token:
                    raise GenerationCancelled(
                        f"generation {started_token} superseded by {_current_generation()}"
                    )
                _model_state["detail"] = (
                    f"Generating audio {i + 1}/{total} on {str(device).upper()}"
                    + (" (CPU - slow; install CUDA torch for GPU)" if device == "cpu" else "")
                )
                kwargs = dict(generate_kwargs)
                if i > 0:
                    kwargs.pop("audio_prompt_path", None)
                elif i == 0 and audio_prompt_path:
                    kwargs["force_prepare"] = False
                part = _generate_chunk(model, chunk, language_id, **kwargs)
                if isinstance(part, torch.Tensor):
                    part = part.detach().cpu()
                else:
                    part = torch.as_tensor(part).cpu()
                if part.dim() == 1:
                    part = part.unsqueeze(0)
                samples = int(part.shape[-1])
                dur = samples / sr if sr > 0 else 0.0

                # Save this chunk immediately so the client can play it now.
                chunk_file = f"page_{page_index}_c{i}_{page_hash}.wav"
                chunk_path = safe_join(output_dir, chunk_file)
                if part.dim() == 1:
                    save_part = part.unsqueeze(0)
                else:
                    save_part = part
                ta.save(chunk_path, save_part, model.sr)

                start_s = round(cursor_s, 4)
                end_s = round(cursor_s + dur, 4)
                chunk_url = f"/sessions/{session_id}/{chunk_file}"
                chunk_urls.append(chunk_url)
                segment_meta.append({"text": chunk, "start_s": start_s, "end_s": end_s})
                cursor_s += dur
                wav_parts.append(part)

                yield {
                    "type": "chunk",
                    "index": i,
                    "total": total,
                    "url": chunk_url,
                    "text": chunk,
                    "start_s": start_s,
                    "end_s": end_s,
                }
        except GenerationCancelled:
            _model_state["status"] = "ready"
            _model_state["detail"] = f"Model ready on {str(device).upper()}."
            raise
        except Exception as e:
            _model_state["status"] = "ready"
            _model_state["detail"] = (
                f"Model ready on {str(device).upper()} "
                f"(last generation failed: {e})"
            )
            raise
        else:
            _model_state["status"] = "ready"
            _model_state["detail"] = f"Model ready on {str(device).upper()}."

    # Save the full concatenated file for cache hits + alignment.
    wav = _concat_wavs(wav_parts)
    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    full_filename = f"page_{page_index}_{page_hash}.wav"
    full_path = safe_join(output_dir, full_filename)
    ta.save(full_path, wav, model.sr)

    result = {
        "audio_url": f"/sessions/{session_id}/{full_filename}",
        "segments": segment_meta,
        "duration_s": round(float(wav.shape[-1]) / sr, 4) if sr > 0 else 0.0,
    }

    try:
        from services.alignment_service import align_words

        word_timings = align_words(text, full_path, language_id)
        if word_timings:
            result["word_timings"] = word_timings
    except Exception as exc:  # noqa: BLE001 - alignment is optional
        _log(f"Forced alignment skipped, falling back to estimates: {exc}")

    result["type"] = "done"
    yield result


def export_cached_pages(session_id, start_page, end_page):
    """Concatenate the newest canonical full-page WAV for each requested page.

    Export deliberately operates only on completed full-page cache files. Chunk
    files and partial clips are excluded, and pages without an audio cache entry
    produce an actionable error instead of silently creating an incomplete book.
    """
    session_id = validate_session_id(session_id)
    start_page = validate_page_index(start_page)
    end_page = validate_page_index(end_page)
    if end_page < start_page:
        raise ValueError("end_page must be greater than or equal to start_page.")

    _, _, sessions_dir = _data_dirs()
    session_dir = safe_join(sessions_dir, session_id)
    if not os.path.isdir(session_dir):
        raise FileNotFoundError("No cached audio exists for this reading session.")

    full_page_re = re.compile(r"^page_(\d+)_([0-9a-f]{16})\.wav$")
    newest_by_page = {}
    for name in os.listdir(session_dir):
        match = full_page_re.match(name)
        if not match:
            continue
        page = int(match.group(1))
        if not start_page <= page <= end_page:
            continue
        path = safe_join(session_dir, name)
        previous = newest_by_page.get(page)
        if previous is None or os.path.getmtime(path) > os.path.getmtime(previous):
            newest_by_page[page] = path

    pages = list(range(start_page, end_page + 1))
    missing = [page for page in pages if page not in newest_by_page]
    if missing:
        missing_text = ", ".join(str(page) for page in missing)
        raise FileNotFoundError(f"Generate audio for page(s) {missing_text} before exporting.")

    wav_parts = []
    sample_rate = None
    source_names = []
    for page in pages:
        path = newest_by_page[page]
        wav, rate = ta.load(path)
        if sample_rate is None:
            sample_rate = rate
        elif rate != sample_rate:
            raise ValueError("Cached pages use incompatible audio sample rates.")
        wav_parts.append(wav)
        source_names.append(os.path.basename(path))

    combined = _concat_wavs(wav_parts)
    if combined.dim() == 1:
        combined = combined.unsqueeze(0)
    digest = hashlib.sha256("\0".join(source_names).encode("utf-8")).hexdigest()[:12]
    filename = f"export_{start_page}-{end_page}_{digest}.wav"
    output_path = safe_join(session_dir, filename)
    ta.save(output_path, combined, sample_rate)
    return {
        "audio_url": f"/sessions/{session_id}/{filename}",
        "pages": pages,
        "duration_s": round(float(combined.shape[-1]) / sample_rate, 4),
    }
