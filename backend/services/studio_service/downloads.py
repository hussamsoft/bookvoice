"""Asset path resolution, output downloads, and project-folder open."""
from __future__ import annotations

import copy
import os
import re
import threading
import time
from pathlib import Path

from . import manifest as _manifest
from .voice_profiles import _source_record


def _is_cancelled(event: threading.Event | None) -> bool:
    return bool(event and event.is_set())


# Cached project-folder sizes keyed by path. ``get_project`` is polled by the
# UI on every render, so walking the tree every time would dominate disk I/O
# for libraries with many large recordings. The cache is invalidated when the
# directory mtime (or its subdirectories' mtimes) changes.
_directory_size_cache: dict[str, tuple[float, int]] = {}
_directory_size_lock = threading.Lock()


def _directory_size(root: Path) -> int:
    try:
        stat = root.stat()
    except OSError:
        return 0
    key = str(root)
    signature = (stat.st_mtime, _max_subdir_mtime(root))
    with _directory_size_lock:
        cached = _directory_size_cache.get(key)
        if cached and cached[0] == signature:
            return cached[1]
    total = 0
    try:
        for path in root.rglob("*"):
            if path.is_file():
                total += path.stat().st_size
    except OSError:
        pass
    with _directory_size_lock:
        _directory_size_cache[key] = (signature, total)
    return total


def _max_subdir_mtime(root: Path) -> float:
    """Largest mtime under ``root``; used as a coarse invalidation signal."""
    latest = 0.0
    try:
        for path in root.rglob("*"):
            try:
                latest = max(latest, path.stat().st_mtime)
            except OSError:
                continue
    except OSError:
        pass
    return latest


def _open_directory(path: Path) -> None:
    from services import access_service

    if access_service.server_mode():
        raise OSError("Opening folders is only available in the desktop app.")
    if os.name != "nt" or not hasattr(os, "startfile"):
        raise OSError("Opening folders is available in the Windows desktop app.")
    os.startfile(str(path))  # type: ignore[attr-defined]


def open_project_folder(project_id: str) -> dict:
    safe_id = _manifest._validate_project_id(project_id)
    _manifest._load_manifest(safe_id)
    root = _manifest.project_dir(safe_id).resolve()
    managed_root = (_manifest.studio_root() / "projects").resolve()
    if root.parent != managed_root or not root.is_dir():
        raise FileNotFoundError("Studio project was not found.")
    _open_directory(root)
    return {"opened": True}


def _download_file_name(value: str, output_id: str) -> str:
    supplied = Path(str(value or "")).name
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", supplied).strip(" .")
    return cleaned or f"bookvoice-{output_id[:8]}.wav"


def output_download(project_id: str, output_id: str) -> tuple[Path, str]:
    """Resolve one device-owned output and its browser download filename."""
    safe_id = _manifest._validate_project_id(project_id)
    if not _manifest.PROJECT_ID_RE.fullmatch(str(output_id or "")):
        raise ValueError("Invalid Studio output id.")
    with _manifest._project_lock(safe_id):
        manifest = _manifest._load_manifest(safe_id, normalize_jobs=False)
        output = next(
            (
                copy.deepcopy(item)
                for item in manifest.get("outputs") or []
                if isinstance(item, dict) and item.get("id") == output_id
            ),
            None,
        )
    if output is None:
        raise FileNotFoundError("Studio output was not found.")
    path = asset_path(safe_id, output_id, "content")
    return path, _download_file_name(output.get("fileName"), output_id)


def asset_path(project_id: str, asset_id: str, variant: str = "content") -> Path:
    safe_id = _manifest._validate_project_id(project_id)
    if not _manifest.PROJECT_ID_RE.fullmatch(str(asset_id or "")):
        raise ValueError("Invalid Studio asset id.")
    manifest = _manifest._load_manifest(safe_id)
    relative = None
    for source in manifest.get("sources") or []:
        if source.get("id") == asset_id:
            if variant == "original":
                relative = source.get("path")
            elif variant == "preview":
                relative = source.get("previewPath")
            elif variant in {"audio", "content"}:
                relative = source.get("audioPath")
            break
    if relative is None:
        for output in manifest.get("outputs") or []:
            if output.get("id") == asset_id and variant in {"content", "audio", "original"}:
                relative = output.get("path")
                break
    if not relative:
        raise FileNotFoundError("Studio asset was not found.")
    root = _manifest.project_dir(safe_id).resolve()
    target = (root / str(relative)).resolve()
    if root not in target.parents or not target.is_file():
        raise FileNotFoundError("Studio asset was not found.")
    return target
