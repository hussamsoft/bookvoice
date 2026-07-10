"""Universal per-user configuration.

One JSON file shared by every install format (MSI, portable dist, dev run).
It lives inside DATA_DIR (%LocalAppData%\\BookVoice\\data by default), so the
same user settings apply no matter how the app was started.

Precedence for runtime options: environment variable > config.json > default.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading

_lock = threading.Lock()

# Keys the API is allowed to read/write. Everything else is dropped.
ALLOWED_KEYS = {
    "voice_id": (str, type(None)),
    "language_id": (str,),
    "ocr_use_gpu": (bool,),
    "tts_device": (str,),
}

DEFAULTS = {
    "voice_id": None,
    "language_id": "en",
    "ocr_use_gpu": False,
    "tts_device": "auto",
}


def _config_path() -> str:
    data_dir = os.environ.get("DATA_DIR", "data")
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, "config.json")


def _read_file() -> dict:
    path = _config_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            return {}
        return raw
    except (OSError, ValueError):
        return {}


def _sanitize(raw: dict) -> dict:
    clean = {}
    for key, types in ALLOWED_KEYS.items():
        if key in raw and isinstance(raw[key], types):
            clean[key] = raw[key]
    # Drop semantically invalid values so a hand-edited config.json cannot
    # push unsupported language/device strings into the live app.
    lang = clean.get("language_id")
    if lang is not None and str(lang).strip().lower() not in ("en", "ar"):
        clean.pop("language_id", None)
    device = clean.get("tts_device")
    if device is not None and str(device).strip().lower() not in (
        "auto",
        "cpu",
        "cuda",
        "mps",
    ):
        clean.pop("tts_device", None)
    voice = clean.get("voice_id")
    if isinstance(voice, str) and not voice.strip():
        clean["voice_id"] = None
    return clean


def get_config() -> dict:
    """Current config merged over defaults."""
    with _lock:
        cfg = dict(DEFAULTS)
        cfg.update(_sanitize(_read_file()))
        return cfg


def update_config(partial: dict) -> dict:
    """Merge whitelisted keys into config.json atomically; returns new config."""
    with _lock:
        current = _sanitize(_read_file())
        current.update(_sanitize(partial))
        path = _config_path()
        fd, tmp = tempfile.mkstemp(
            prefix=".config-", suffix=".tmp", dir=os.path.dirname(path)
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(current, f, indent=2)
            os.replace(tmp, path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        cfg = dict(DEFAULTS)
        cfg.update(current)
        return cfg


def config_value(key: str, default=None):
    return get_config().get(key, default)


def app_version() -> str:
    """Read the VERSION file bundled next to main.py (or repo root in dev)."""
    candidates = []
    app_dir = os.environ.get("APP_DIR", "").strip()
    if app_dir:
        candidates.append(os.path.join(app_dir, "VERSION"))
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.join(here, "..", "VERSION"))
    candidates.append(os.path.join(here, "..", "..", "VERSION"))
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as f:
                v = f.read().strip()
            if v:
                return v
        except OSError:
            continue
    return "dev"
