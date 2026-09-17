"""Voice conversion: re-render a project recording in a target voice.

Speech-to-speech conversion preserves the source performance — timing,
rhythm, emphasis — so the narration controls are not involved.
"""
from __future__ import annotations

import copy
import os
import re
import tempfile
import threading
import time
import uuid
from pathlib import Path

from services.path_utils import validate_voice_id

from . import manifest as _manifest
from .media import _copy_atomic, _sha256_file
from .narration import _extract_clip
from .voice_profiles import _EventCancellation, _source_record


# Speech-to-speech conversion carries the source performance, so the clip only
# has to be long enough for the decoder to lock onto the target timbre.
CONVERSION_MIN_SOURCE_SEC = 0.5
CONVERSION_MAX_SOURCE_SEC = 60 * 60


def _resolve_conversion_span(source: dict, start_sec, end_sec) -> tuple[float, float]:
    duration = float(source.get("durationSec") or 0)
    start = 0.0 if start_sec is None else float(start_sec)
    end = duration if end_sec is None else float(end_sec)
    if start < 0:
        raise ValueError("Conversion start time may not be negative.")
    if end > duration + 0.01:
        raise ValueError("The selected region extends beyond the recording.")
    span = end - start
    if span < CONVERSION_MIN_SOURCE_SEC:
        raise ValueError("Select at least half a second of speech to convert.")
    if span > CONVERSION_MAX_SOURCE_SEC:
        raise ValueError("Conversions are limited to one hour of audio at a time.")
    return start, span


def create_conversion(
    project_id: str,
    source_id: str,
    *,
    start_sec: float | None = None,
    end_sec: float | None = None,
    target_voice_id: str | None = None,
    target_source_id: str | None = None,
    target_start_sec: float | None = None,
    target_end_sec: float | None = None,
    consent_confirmed: bool = False,
    cancel_event: threading.Event | None = None,
    progress=None,
) -> dict:
    """Re-render a project recording in a target voice, preserving its delivery.

    The converted performance inherits the source timing, rhythm and emphasis, so
    the narration controls are not involved in matching the sound.
    """
    if not consent_confirmed:
        raise ValueError("Confirm that you own or have permission to use this voice.")
    if bool(target_voice_id) == bool(target_source_id):
        raise ValueError("Choose exactly one target voice: a saved profile or a recording.")
    safe_id = _manifest._validate_project_id(project_id)
    from .projects import get_project
    get_project(safe_id)
    with _manifest._project_lock(safe_id):
        manifest = _manifest._load_manifest(safe_id)
        source = copy.deepcopy(_source_record(manifest, source_id))
        target_source = (
            copy.deepcopy(_source_record(manifest, target_source_id))
            if target_source_id
            else None
        )

    start, span = _resolve_conversion_span(source, start_sec, end_sec)
    root = _manifest.project_dir(safe_id)
    source_audio = (root / str(source.get("audioPath") or "")).resolve()
    if root.resolve() not in source_audio.parents or not source_audio.is_file():
        raise FileNotFoundError("Studio source audio was not found.")

    staging = _manifest.studio_root() / "staging"
    temp_paths: list[Path] = []

    def _staged(prefix: str) -> Path:
        handle, name = tempfile.mkstemp(prefix=prefix, suffix=".wav", dir=staging)
        os.close(handle)
        path = Path(name)
        temp_paths.append(path)
        return path

    try:
        trimmed = source_audio
        if start > 0.001 or span < float(source.get("durationSec") or 0) - 0.001:
            trimmed = _staged("studio-convert-source-")
            _extract_clip(source_audio, trimmed, start_sec=start, duration_sec=span)

        from services import generation_gateway, tts_service, voice_profile_service

        if target_voice_id:
            voice = validate_voice_id(target_voice_id)
            reference = voice_profile_service.voices_dir() / f"{voice}.wav"
            if not reference.is_file():
                raise FileNotFoundError("The target voice profile was not found.")
            target_label = voice
        else:
            voice = None
            target_audio = (root / str(target_source.get("audioPath") or "")).resolve()
            if root.resolve() not in target_audio.parents or not target_audio.is_file():
                raise FileNotFoundError("The target voice recording was not found.")
            target_start, target_span = _resolve_conversion_span(
                target_source, target_start_sec, target_end_sec
            )
            target_span = min(target_span, 30.0)
            reference = _staged("studio-convert-target-")
            _extract_clip(
                target_audio, reference, start_sec=target_start, duration_sec=target_span
            )
            target_label = str(target_source.get("fileName") or "recording")

        if cancel_event is not None and cancel_event.is_set():
            raise RuntimeError("Voice conversion was cancelled.")

        session_id = f"studio-{safe_id}"
        # Cache signature uses only content-addressed values: the source
        # SHA256, the trim window, and the target reference SHA256. The
        # human-readable target_label / fileName is intentionally excluded
        # so a caller-controlled filename cannot poison the cache key.
        signature = (
            f'{source.get("sha256")}:{start:.3f}:{span:.3f}:{_sha256_file(reference)}'
        )
        filename = tts_service.conversion_filename(signature, voice)
        cancellation = _EventCancellation(cancel_event)
        # Both staged files live under DATA_DIR, so a remote worker sharing the
        # same storage reaches them at these exact paths.
        generated = generation_gateway.convert(
            session_id,
            str(trimmed),
            str(reference),
            filename,
            cancellation=cancellation,
            progress=progress,
        )
    finally:
        for path in temp_paths:
            path.unlink(missing_ok=True)

    if cancel_event is not None and cancel_event.is_set():
        raise RuntimeError("Voice conversion was cancelled.")
    from .repair import _session_audio_path
    rendered = _session_audio_path(session_id, str(generated.get("audio_url") or ""))
    if not rendered.is_file():
        raise FileNotFoundError("The converted audio was not found.")

    output_id = uuid.uuid4().hex
    target_path = _manifest.project_dir(safe_id) / "outputs" / f"{output_id}.wav"
    _copy_atomic(rendered, target_path)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", Path(str(source.get("fileName") or "recording")).stem)
    record = {
        "id": output_id,
        "kind": "CONVERSION",
        "fileName": f'{stem.strip("-") or "recording"}-converted.wav',
        "format": "WAV",
        "sourceId": source.get("id"),
        "sourceFileName": source.get("fileName"),
        "startSec": round(start, 3),
        "endSec": round(start + span, 3),
        "voiceId": voice,
        "targetVoiceName": target_label,
        "targetSourceId": target_source.get("id") if target_source else None,
        "segments": [],
        "wordTimings": [],
        "durationSec": float(generated.get("duration_s") or 0),
        "sizeBytes": target_path.stat().st_size,
        "sha256": _sha256_file(target_path),
        "path": str(target_path.relative_to(_manifest.project_dir(safe_id))).replace("\\", "/"),
        "createdAt": time.time(),
    }
    with _manifest._project_lock(safe_id):
        manifest = _manifest._load_manifest(safe_id, normalize_jobs=False)
        if voice:
            manifest["voiceId"] = voice
        manifest.setdefault("outputs", []).append(record)
        manifest["updatedAt"] = time.time()
        _manifest._write_json_atomic(_manifest._manifest_path(safe_id), manifest)
        return _manifest._public_project(manifest)["outputs"][-1]
