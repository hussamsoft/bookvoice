"""Voice profile creation from a Studio project source.

Wraps ``voice_profile_service.create_profile`` with the Studio-specific
clip-extraction (5–30 seconds at 24 kHz mono) and consent check.
"""
from __future__ import annotations

import copy
import os
import tempfile
import threading
from pathlib import Path

from . import manifest as _manifest
from .media import _extract_edit_audio, _run_media_tool
from . import media as _media


class _EventCancellation:
    def __init__(self, event: threading.Event | None):
        self._event = event

    def cancelled(self) -> bool:
        return bool(self._event and self._event.is_set())


def _copy_atomic(source: Path, target: Path) -> None:
    """Thin wrapper for the shared helper in media.py.

    Kept as a private alias so callers in this module do not need to
    reach into ``.media`` directly. Audit finding C-36: deduplicate
    the previously-duplicated implementations.
    """
    from .media import _copy_atomic as _media_copy_atomic

    _media_copy_atomic(source, target)


def _source_record(manifest: dict, source_id: str) -> dict:
    if not _manifest.PROJECT_ID_RE.fullmatch(str(source_id or "")):
        raise ValueError("Invalid Studio source id.")
    for source in manifest.get("sources") or []:
        if isinstance(source, dict) and source.get("id") == source_id:
            return source
    raise FileNotFoundError("Studio source was not found.")


def create_voice_profile(
    project_id: str,
    source_id: str,
    name: str,
    start_sec: float,
    end_sec: float,
    *,
    consent_confirmed: bool,
) -> dict:
    if not consent_confirmed:
        raise ValueError("Confirm that you own or have permission to clone this voice.")
    safe_id = _manifest._validate_project_id(project_id)
    with _manifest._project_lock(safe_id):
        manifest = _manifest._load_manifest(safe_id)
        source = copy.deepcopy(_source_record(manifest, source_id))
    try:
        start = float(start_sec)
        end = float(end_sec)
    except (TypeError, ValueError) as exc:
        raise ValueError("Profile clip times must be numbers.") from exc
    duration = end - start
    if start < 0 or duration < 5 or duration > 30:
        raise ValueError("Voice profile clips must be between 5 and 30 seconds.")
    if end > float(source.get("durationSec") or 0) + 0.01:
        raise ValueError("Voice profile clip extends beyond the source media.")
    root = _manifest.project_dir(safe_id)
    original = (root / str(source.get("path") or "")).resolve()
    if root.resolve() not in original.parents or not original.is_file():
        raise FileNotFoundError("Studio source was not found.")

    fd, temp_name = tempfile.mkstemp(prefix="studio-profile-", suffix=".wav", dir=_manifest.studio_root() / "staging")
    os.close(fd)
    clip = Path(temp_name)
    try:
        _media._extract_profile_clip(original, clip, start_sec=start, duration_sec=duration)
        from services import voice_profile_service

        return voice_profile_service.create_profile(
            clip,
            name,
            consent_confirmed=True,
            source_info={
                "kind": source.get("mediaType") or "AUDIO",
                "fileName": source.get("fileName"),
            },
        )
    finally:
        clip.unlink(missing_ok=True)
