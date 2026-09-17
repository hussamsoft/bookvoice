"""TTS model state, loading, and lifecycle.

The model module owns the global model state (``_model``, ``_model_type``,
``_model_state``) and the voice-conversion-only S3Gen instance. ``get_model``
is the single entry point for the lazy load and the English↔multilingual
switch; the rest of the package reads/writes the state through this module.
"""
from __future__ import annotations

import gc
import hashlib
import importlib.metadata
import os
import tempfile
import threading
import time
from pathlib import Path

import torch

from services.config_service import app_version, config_value
from services.path_utils import validate_voice_id

from . import queue as _queue


# Owned by the model module: narration model, voice-conversion S3Gen,
# shared locks, voice reference checksum cache, and the public status
# snapshot consumed by the UI. ``_model_state`` is the single source of
# truth for what ``/api/tts/status`` reports.
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
# Voice conversion only needs the S3Gen decoder. It is cached separately so a
# machine that cannot hold the full narration model can still convert audio.
_vc_model = None
_vc_model_device: str | None = None
# The S3Gen instance the cached converter was built over, tracked explicitly so
# a converter borrowed from the narration model can be told apart from a
# standalone one without depending on what the wrapper re-exposes.
_vc_source_s3gen = None
_vc_lock = threading.Lock()


# Avoid re-running expensive prepare_conditionals for the same voice prompt
# across consecutive chunks / narrate calls (big win on voice switch).
_last_voice_prompt: str | None = None
_last_voice_exaggeration: float | None = None

# Chunk-size budgets — GPU can handle larger pieces (fewer slow generate()
# calls). The narration module reads these through ``_chunk_limits``.
_CHUNK_TARGET_CHARS_GPU = 480
_CHUNK_HARD_MAX_GPU = 700
_CHUNK_TARGET_CHARS_CPU = 180
_CHUNK_HARD_MAX_CPU = 260


def _log(msg: str) -> None:
    """Print without ever crashing on Windows cp1252/charmap consoles."""
    import sys
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
    voices_dir = os.environ.get("VOICE_DATA_DIR", "").strip() or os.path.join(data_dir, "voices")
    sessions_dir = os.path.join(data_dir, "sessions")
    os.makedirs(voices_dir, exist_ok=True)
    os.makedirs(sessions_dir, exist_ok=True)
    return data_dir, voices_dir, sessions_dir


def _chatterbox_model_version() -> str:
    for distribution in ("chatterbox-tts", "chatterbox"):
        try:
            return importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            continue
    return "bundled-unknown"


_voice_checksum_cache: dict[tuple[str, int, int], str] = {}
_VOICE_CHECKSUM_CACHE_MAX = 256


def _voice_reference_checksum(voice_id: str | None) -> str:
    if not voice_id:
        return "default"
    _, voices_dir, _ = _data_dirs()
    prompt = Path(voices_dir) / f"{validate_voice_id(voice_id)}.wav"
    if not prompt.is_file():
        return "missing"
    try:
        stat = prompt.stat()
    except OSError:
        return "missing"
    # Keyed on size+mtime so a re-recorded voice prompt invalidates the entry.
    cache_key = (str(prompt), stat.st_size, stat.st_mtime_ns)
    cached = _voice_checksum_cache.get(cache_key)
    if cached is not None:
        return cached
    digest = hashlib.sha256()
    with prompt.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    result = digest.hexdigest()
    if len(_voice_checksum_cache) >= _VOICE_CHECKSUM_CACHE_MAX:
        _voice_checksum_cache.clear()
    _voice_checksum_cache[cache_key] = result
    return result


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


def _voice_condition_cache_path(audio_prompt_path: str, model) -> Path:
    prompt = Path(audio_prompt_path)
    digest = hashlib.sha256()
    with prompt.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    kind = "multilingual" if "Multilingual" in type(model).__name__ else "en"
    digest.update(b"\0")
    digest.update(_chatterbox_model_version().encode("utf-8"))
    digest.update(b"\0")
    digest.update(type(model).__name__.encode("utf-8"))
    return prompt.with_name(f"{prompt.stem}.{kind}.{digest.hexdigest()[:12]}.conds.pt")


def _prepare_voice_conditionals(model, audio_prompt_path: str, *, force: bool = False) -> None:
    if not force and getattr(model, "_bookvoice_voice_prompt", None) == audio_prompt_path:
        if model.conds is not None:
            return
    cache_path = _voice_condition_cache_path(audio_prompt_path, model)
    if cache_path.is_file() and not force:
        if "Multilingual" in type(model).__name__:
            from chatterbox.mtl_tts import Conditionals
        else:
            from chatterbox.tts import Conditionals
        model.conds = Conditionals.load(cache_path, map_location="cpu").to(model.device)
    else:
        model.prepare_conditionals(audio_prompt_path, exaggeration=0.5)
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{cache_path.name}-", suffix=".tmp", dir=cache_path.parent
        )
        os.close(fd)
        temp_path = Path(temp_name)
        try:
            model.conds.save(temp_path)
            os.replace(temp_path, cache_path)
        finally:
            temp_path.unlink(missing_ok=True)
        prefix = f"{Path(audio_prompt_path).stem}."
        for stale in cache_path.parent.glob(f"{prefix}*.conds.pt"):
            if stale != cache_path and (
                ".en." in stale.name or ".multilingual." in stale.name
            ):
                stale.unlink(missing_ok=True)
    model._bookvoice_voice_prompt = audio_prompt_path


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


def get_model(language_id="en"):
    global _model, _model_type
    from services.path_utils import validate_language_id
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
                    "(minutes per page). Install the GPU-enabled BookVoice build or "
                    "set TTS_DEVICE=cpu deliberately for CPU-only machines."
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
    from .synth import maybe_cleanup_sessions
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
    _queue.submit_tts(_queue.TtsPriority.INTERACTIVE, preload_model, language_id)
    return state_snapshot()
