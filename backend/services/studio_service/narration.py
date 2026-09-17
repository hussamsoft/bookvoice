"""Standalone Studio narration: typed text → immutable WAV output."""
from __future__ import annotations

import copy
import os
import re
import threading
import time
import uuid
from pathlib import Path

from services.path_utils import (
    validate_language_id,
    validate_narration_text_length,
    validate_voice_id,
)

from . import manifest as _manifest
from .media import _copy_atomic, _sha256_file
from .voice_profiles import _EventCancellation  # used by create_narration


DEFAULT_GENERATION_SETTINGS = {
    "pace": 1.0,
    "expression": 0.5,
    "temperature": 0.8,
    "guidance": None,
    "seed": None,
}


def validate_generation_settings(value: dict | None) -> dict:
    raw = value or {}
    if not isinstance(raw, dict):
        raise ValueError("Generation settings must be an object.")
    unknown = set(raw) - set(DEFAULT_GENERATION_SETTINGS)
    if unknown:
        raise ValueError(f"Unsupported generation setting: {sorted(unknown)[0]}.")

    def bounded_float(key: str, low: float, high: float) -> float:
        try:
            number = float(raw.get(key, DEFAULT_GENERATION_SETTINGS[key]))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{key} must be a number.") from exc
        if not low <= number <= high:
            raise ValueError(f"{key} must be between {low} and {high}.")
        return round(number, 4)

    guidance_value = raw.get("guidance", DEFAULT_GENERATION_SETTINGS["guidance"])
    guidance = None
    if guidance_value is not None:
        try:
            guidance = float(guidance_value)
        except (TypeError, ValueError) as exc:
            raise ValueError("guidance must be a number or null.") from exc
        if not 0 <= guidance <= 1:
            raise ValueError("guidance must be between 0 and 1.")
        guidance = round(guidance, 4)

    seed = raw.get("seed", DEFAULT_GENERATION_SETTINGS["seed"])
    if seed in (None, ""):
        seed = None
    elif isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 4_294_967_295:
        raise ValueError("seed must be a whole number between 0 and 4294967295, or null.")

    return {
        "pace": bounded_float("pace", 0.75, 1.25),
        "expression": bounded_float("expression", 0.0, 1.0),
        "temperature": bounded_float("temperature", 0.1, 1.5),
        "guidance": guidance,
        "seed": seed,
    }


def _extract_clip(source: Path, target: Path, *, start_sec: float, duration_sec: float) -> None:
    """Cut a mono 24 kHz PCM region out of a project source."""
    from .media import _extract_profile_clip
    _extract_profile_clip(source, target, start_sec=start_sec, duration_sec=duration_sec)


def create_narration(
    project_id: str,
    text: str,
    language_id: str,
    voice_id: str | None,
    generation_settings: dict,
    *,
    cancel_event: threading.Event | None = None,
) -> dict:
    from .projects import get_project
    safe_id = _manifest._validate_project_id(project_id)
    script = validate_narration_text_length(text)
    language = validate_language_id(language_id)
    voice = validate_voice_id(voice_id) if voice_id else None
    settings = validate_generation_settings(generation_settings)
    project = get_project(safe_id)

    from services import generation_gateway

    session_id = f"studio-{safe_id}"
    cancellation = _EventCancellation(cancel_event)
    generated = generation_gateway.narrate(
        session_id, script, language, voice, settings, cancellation=cancellation
    )
    if cancellation.cancelled():
        raise RuntimeError("Studio narration was cancelled.")
    prefix = f"/sessions/{session_id}/"
    audio_url = str(generated.get("audio_url") or "")
    if not audio_url.startswith(prefix):
        raise RuntimeError("Generated Studio audio path is invalid.")
    filename = audio_url[len(prefix):]
    if not filename or Path(filename).name != filename:
        raise RuntimeError("Generated Studio audio path is invalid.")
    source = Path(os.environ.get("DATA_DIR", "data")) / "sessions" / session_id / filename
    if not source.is_file():
        raise FileNotFoundError("Generated Studio audio was not found.")

    output_id = uuid.uuid4().hex
    target = _manifest.project_dir(safe_id) / "outputs" / f"{output_id}.wav"
    _copy_atomic(source, target)
    segments = [
        {
            "text": str(segment.get("text") or ""),
            "startSec": float(segment.get("startSec", segment.get("start_s", 0.0)) or 0.0),
            "endSec": float(segment.get("endSec", segment.get("end_s", 0.0)) or 0.0),
        }
        for segment in (generated.get("segments") or [])
    ]
    word_timings = [
        {
            "word": str(timing.get("word") or ""),
            "startSec": float(timing.get("startSec", timing.get("start_s", 0.0)) or 0.0),
            "endSec": float(timing.get("endSec", timing.get("end_s", 0.0)) or 0.0),
        }
        for timing in (generated.get("word_timings") or [])
    ]
    record = {
        "id": output_id,
        "kind": "NARRATION",
        "fileName": f"{re.sub(r'[^A-Za-z0-9_-]+', '-', project['name']).strip('-') or 'narration'}.wav",
        "format": "WAV",
        "text": script,
        "languageId": language,
        "voiceId": voice,
        "generationSettings": settings,
        "segments": segments,
        "wordTimings": word_timings,
        "durationSec": float(generated.get("duration_s") or 0),
        "sizeBytes": target.stat().st_size,
        "sha256": _sha256_file(target),
        "path": str(target.relative_to(_manifest.project_dir(safe_id))).replace("\\", "/"),
        "createdAt": time.time(),
    }
    with _manifest._project_lock(safe_id):
        manifest = _manifest._load_manifest(safe_id, normalize_jobs=False)
        manifest["script"] = script
        manifest["languageId"] = language
        manifest["voiceId"] = voice
        manifest["generationSettings"] = settings
        manifest.setdefault("outputs", []).append(record)
        manifest["updatedAt"] = time.time()
        _manifest._write_json_atomic(_manifest._manifest_path(safe_id), manifest)
        return _manifest._public_project(manifest)["outputs"][-1]
