"""Recording-retention helpers for Voice Studio microphone takes.

Microphone takes are bounded to a 30-day retention window. The manifest
keeps an ``expiresAt`` per managed recording; ``purge_expired_recordings``
is invoked from the app lifespan and walks every project on disk.
"""
from __future__ import annotations

import re
import time
from pathlib import Path

from . import manifest as _manifest


RECORDING_RETENTION_DAYS = 30
RECORDING_RETENTION_SEC = RECORDING_RETENTION_DAYS * 24 * 60 * 60
CAPTURE_METHODS = {"upload", "recording"}
LEGACY_RECORDING_RE = re.compile(
    r"^recording-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.wav$",
    re.IGNORECASE,
)


def _is_managed_recording(source: dict) -> bool:
    capture_method = str(source.get("captureMethod") or "").strip().lower()
    if capture_method:
        return capture_method == "recording"
    # BookVoice microphone takes used this exact filename contract before
    # captureMethod/expiresAt were written to manifests.
    return bool(
        source.get("mediaType") == "AUDIO"
        and LEGACY_RECORDING_RE.fullmatch(str(source.get("fileName") or ""))
    )


def _source_expiry(source: dict) -> float:
    try:
        expires_at = float(source.get("expiresAt"))
    except (TypeError, ValueError):
        expires_at = 0.0
    if expires_at > 0:
        return expires_at
    try:
        created_at = float(source.get("createdAt"))
    except (TypeError, ValueError):
        created_at = 0.0
    return created_at + RECORDING_RETENTION_SEC if created_at > 0 else 0.0


def _delete_source_files(project_id: str, source: dict) -> bool:
    root = _manifest.project_dir(project_id).resolve()
    deleted = True
    for key in ("path", "audioPath", "waveformPath", "previewPath"):
        relative = str(source.get(key) or "").strip()
        if not relative:
            continue
        candidate = (root / relative).resolve()
        if root not in candidate.parents:
            continue
        try:
            candidate.unlink(missing_ok=True)
        except OSError as exc:
            deleted = False
            print(f"[studio] could not delete expired recording asset {candidate.name}: {exc}")
    return deleted


def purge_expired_recordings(*, now: float | None = None) -> int:
    """Erase expired microphone takes across all device-owned projects."""
    removed = 0
    for candidate in (_manifest.studio_root() / "projects").iterdir():
        if not candidate.is_dir() or not _manifest.PROJECT_ID_RE.fullmatch(candidate.name):
            continue
        with _manifest._project_lock(candidate.name):
            try:
                manifest = _manifest._read_manifest_unscoped(candidate.name)
            except (FileNotFoundError, RuntimeError, ValueError):
                continue
            changed, project_removed = _manifest._purge_manifest_recordings(
                candidate.name,
                manifest,
                now=now,
            )
            if changed:
                _manifest._write_json_atomic(candidate / "manifest.json", manifest)
            removed += project_removed
    return removed
