"""Project CRUD: create, list, update, duplicate, delete, and legacy claim."""
from __future__ import annotations

import copy
import shutil
import time
import uuid
from pathlib import Path

from . import manifest as _manifest


def create_project(name: str = "Untitled project") -> dict:
    project_id = uuid.uuid4().hex
    target = _manifest.project_dir(project_id)
    target.mkdir(parents=False, exist_ok=False)
    for child in ("sources", "derived", "outputs"):
        (target / child).mkdir()
    manifest = _manifest._new_manifest(project_id, name)
    _manifest._write_json_atomic(target / "manifest.json", manifest)
    return _manifest._public_project(manifest)


def list_projects() -> list[dict]:
    projects = []
    for candidate in (_manifest.studio_root() / "projects").iterdir():
        if not candidate.is_dir() or not _manifest.PROJECT_ID_RE.fullmatch(candidate.name):
            continue
        try:
            projects.append(_manifest._public_project(_manifest._load_manifest(candidate.name)))
        except (FileNotFoundError, RuntimeError, ValueError):
            continue
    projects.sort(key=lambda item: float(item.get("updatedAt") or 0), reverse=True)
    return projects


def legacy_projects_available() -> bool:
    """Return whether projects from the pre-device release still need an owner."""
    for candidate in (_manifest.studio_root() / "projects").iterdir():
        if not candidate.is_dir() or not _manifest.PROJECT_ID_RE.fullmatch(candidate.name):
            continue
        try:
            manifest = _manifest._read_manifest_unscoped(candidate.name)
        except (FileNotFoundError, RuntimeError, ValueError):
            continue
        if not manifest.get("deviceId"):
            return True
    return False


def claim_legacy_projects() -> int:
    """Assign every unowned pre-device project to the current device once."""
    from .devices import current_device_id
    owner = current_device_id()
    claimed = 0
    with _manifest._legacy_claim_lock:
        for candidate in (_manifest.studio_root() / "projects").iterdir():
            if not candidate.is_dir() or not _manifest.PROJECT_ID_RE.fullmatch(candidate.name):
                continue
            with _manifest._project_lock(candidate.name):
                try:
                    manifest = _manifest._read_manifest_unscoped(candidate.name)
                except (FileNotFoundError, RuntimeError, ValueError):
                    continue
                if manifest.get("deviceId"):
                    continue
                manifest["deviceId"] = owner
                _manifest._write_json_atomic(candidate / "manifest.json", manifest)
                claimed += 1
    return claimed


def get_project(project_id: str) -> dict:
    safe_id = _manifest._validate_project_id(project_id)
    with _manifest._project_lock(safe_id):
        return _manifest._public_project(_manifest._load_manifest(safe_id))


def update_project(project_id: str, changes: dict) -> dict:
    from .jobs import WORKFLOWS
    from .narration import validate_generation_settings
    safe_id = _manifest._validate_project_id(project_id)
    allowed = {
        "name",
        "script",
        "languageId",
        "voiceId",
        "generationSettings",
        "activeWorkflow",
    }
    unknown = set(changes) - allowed
    if unknown:
        raise ValueError(f"Unsupported project field: {sorted(unknown)[0]}.")
    with _manifest._project_lock(safe_id):
        manifest = _manifest._load_manifest(safe_id)
        if "name" in changes:
            manifest["name"] = _manifest._clean_name(changes["name"])
        if "script" in changes:
            script = str(changes["script"] or "")
            if len(script) > _manifest.SCRIPT_MAX_CHARS:
                raise ValueError(f"Studio scripts may not exceed {_manifest.SCRIPT_MAX_CHARS} characters.")
            manifest["script"] = script
        if "languageId" in changes:
            language = str(changes["languageId"] or "").lower()
            if language not in {"en", "ar"}:
                raise ValueError("Voice Studio supports English and Arabic.")
            manifest["languageId"] = language
        if "voiceId" in changes:
            manifest["voiceId"] = changes["voiceId"] or None
        if "generationSettings" in changes:
            manifest["generationSettings"] = validate_generation_settings(
                changes["generationSettings"]
            )
        if "activeWorkflow" in changes:
            workflow = str(changes["activeWorkflow"] or "").upper()
            if workflow not in WORKFLOWS:
                raise ValueError("Invalid Studio workflow.")
            manifest["activeWorkflow"] = workflow
        manifest["updatedAt"] = time.time()
        _manifest._write_json_atomic(_manifest._manifest_path(safe_id), manifest)
        return _manifest._public_project(manifest)


def duplicate_project(project_id: str) -> dict:
    source_id = _manifest._validate_project_id(project_id)
    with _manifest._project_lock(source_id):
        original = _manifest._load_manifest(source_id)
        copied_id = uuid.uuid4().hex
        destination = _manifest.project_dir(copied_id)
        # Callers are expected to run this off the event loop (see
        # routes/studio.py:186); ``shutil.copytree`` walks the entire
        # project folder and would otherwise stall every other request.
        shutil.copytree(_manifest.project_dir(source_id), destination)
        copied = copy.deepcopy(original)
        now = time.time()
        copied["id"] = copied_id
        copied["name"] = _manifest._clean_name(f'{original["name"]} copy')
        copied["createdAt"] = now
        copied["updatedAt"] = now
        copied["jobs"] = []
        _manifest._write_json_atomic(destination / "manifest.json", copied)
        return _manifest._public_project(copied)


def delete_project(project_id: str) -> None:
    safe_id = _manifest._validate_project_id(project_id)
    _manifest._load_manifest(safe_id)
    target = _manifest.project_dir(safe_id)
    if not target.is_dir():
        raise FileNotFoundError("Studio project was not found.")
    with _manifest._project_lock(safe_id):
        resolved_root = (_manifest.studio_root() / "projects").resolve()
        resolved_target = target.resolve()
        if resolved_target.parent != resolved_root:
            raise ValueError("Invalid Studio project path.")
        shutil.rmtree(resolved_target)
    with _manifest._locks_guard:
        _manifest._project_locks.pop(safe_id, None)


def reset_runtime_state_for_tests() -> None:
    from .devices import DEFAULT_DEVICE_ID
    from . import devices as _devices
    _devices._device_id.set(DEFAULT_DEVICE_ID)
    with _manifest._jobs_guard:
        for event in _manifest._job_cancellations.values():
            event.set()
        _manifest._job_cancellations.clear()
        _manifest._active_job_ids.clear()
    with _manifest._locks_guard:
        _manifest._project_locks.clear()
