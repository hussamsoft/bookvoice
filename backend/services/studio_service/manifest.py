"""Manifest IO and shared project/job state.

The manifest module owns the per-project locks, the active-job registry,
and the on-disk JSON read/write helpers. Other modules in the package
read these via attribute access (``_manifest._project_locks``,
``_manifest._write_json_atomic``) so the state has a single home.
"""
from __future__ import annotations

import atexit
import copy
import json
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from pathlib import Path

from services.storage_utils import replace_file_with_retry


SCHEMA_VERSION = 1
PROJECT_ID_RE = re.compile(r"^[0-9a-f]{32}$")
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
PROJECT_NAME_MAX = 100
SCRIPT_MAX_CHARS = 200_000
MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024
MAX_SOURCE_DURATION_SEC = 6 * 60 * 60
WORKFLOWS = {"NARRATION", "CONVERSION", "REPAIR"}

_locks_guard = threading.Lock()
_project_locks: dict[str, threading.RLock] = {}
_jobs_guard = threading.Lock()
_job_cancellations: dict[str, threading.Event] = {}
_active_job_ids: set[str] = set()
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="bookvoice-studio-media")
_legacy_claim_lock = threading.Lock()


# ``atexit`` runs the executor shutdown at interpreter exit so background
# threads cannot leak between requests during tests or quick restarts.
@atexit.register
def _shutdown_executor() -> None:
    _executor.shutdown(wait=False)


from .devices import DEVICE_ID_RE, current_device_id  # noqa: E402  (after constants)


def studio_root() -> Path:
    root = Path(os.environ.get("DATA_DIR", "data")) / "studio"
    (root / "projects").mkdir(parents=True, exist_ok=True)
    (root / "staging").mkdir(parents=True, exist_ok=True)
    return root


def _validate_project_id(project_id: str) -> str:
    value = str(project_id or "")
    if not PROJECT_ID_RE.fullmatch(value):
        raise ValueError("Invalid Studio project id.")
    return value


def _validate_job_id(job_id: str) -> str:
    value = str(job_id or "")
    if not JOB_ID_RE.fullmatch(value):
        raise ValueError("Invalid Studio job id.")
    return value


def project_dir(project_id: str) -> Path:
    return studio_root() / "projects" / _validate_project_id(project_id)


def _project_lock(project_id: str) -> threading.RLock:
    safe_id = _validate_project_id(project_id)
    with _locks_guard:
        return _project_locks.setdefault(safe_id, threading.RLock())


def _clean_name(name: str) -> str:
    value = " ".join(str(name or "").split()).strip()
    if not value:
        raise ValueError("Project name is required.")
    if len(value) > PROJECT_NAME_MAX:
        raise ValueError(f"Project names may not exceed {PROJECT_NAME_MAX} characters.")
    return value


def _manifest_path(project_id: str) -> Path:
    return project_dir(project_id) / "manifest.json"


def _write_json_atomic(path: Path, payload: dict | list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}-", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        replace_file_with_retry(temp_path, path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _new_manifest(project_id: str, name: str) -> dict:
    now = time.time()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "id": project_id,
        "deviceId": current_device_id(),
        "name": _clean_name(name),
        "createdAt": now,
        "updatedAt": now,
        "activeWorkflow": "NARRATION",
        "script": "",
        "languageId": "en",
        "voiceId": None,
        "generationSettings": dict(_new_manifest_settings()),
        "sources": [],
        "outputs": [],
        "repairs": [],
        "jobs": [],
    }


def _new_manifest_settings() -> dict:
    # Late import to avoid a cycle: ``narration`` references manifest
    # constants but the constants here are referenced by the default
    # manifest values.
    from .narration import DEFAULT_GENERATION_SETTINGS
    return DEFAULT_GENERATION_SETTINGS


def _normalize_interrupted_jobs(manifest: dict) -> bool:
    changed = False
    for job in manifest.get("jobs") or []:
        if (
            isinstance(job, dict)
            and job.get("status") in {"QUEUED", "RUNNING"}
            and job.get("id") not in _active_job_ids
        ):
            job["status"] = "INTERRUPTED"
            job["canRetry"] = True
            job["message"] = "BookVoice closed before this job completed. Retry it from the project."
            job["updatedAt"] = time.time()
            changed = True
    return changed


def _read_manifest_unscoped(project_id: str) -> dict:
    path = _manifest_path(project_id)
    for attempt in range(5):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            break
        except FileNotFoundError as exc:
            raise FileNotFoundError("Studio project was not found.") from exc
        except PermissionError as exc:
            # On Windows, a reader can briefly collide with os.replace while a
            # background job commits an updated manifest. Retrying this narrow
            # sharing violation keeps UI polling from reporting a false
            # metadata failure without masking persistent storage errors.
            if attempt == 4:
                raise RuntimeError("Studio project metadata is unavailable.") from exc
            time.sleep(0.01 * (attempt + 1))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError("Studio project metadata is unavailable.") from exc
    if not isinstance(raw, dict) or raw.get("id") != project_id:
        raise RuntimeError("Studio project metadata is invalid.")
    if int(raw.get("schemaVersion") or 0) != SCHEMA_VERSION:
        raise RuntimeError("Studio project uses an unsupported schema version.")
    owner = str(raw.get("deviceId") or "")
    if owner and not DEVICE_ID_RE.fullmatch(owner):
        raise RuntimeError("Studio project metadata has an invalid device owner.")
    return raw


def _load_manifest(project_id: str, *, normalize_jobs: bool = True) -> dict:
    safe_id = _validate_project_id(project_id)
    path = _manifest_path(safe_id)
    with _project_lock(safe_id):
        raw = _read_manifest_unscoped(safe_id)
        if raw.get("deviceId") != current_device_id():
            # A project owned by another device is deliberately indistinguishable
            # from an unknown id. This prevents list filtering from being bypassed
            # by copying or guessing a project URL.
            raise FileNotFoundError("Studio project was not found.")
        changed, _removed = _purge_manifest_recordings(safe_id, raw)
        if normalize_jobs:
            changed = _normalize_interrupted_jobs(raw) or changed
        if changed:
            _write_json_atomic(path, raw)
        return raw


def _public_project(manifest: dict) -> dict:
    from .downloads import _directory_size
    result = copy.deepcopy(manifest)
    result.pop("deviceId", None)
    for source in result.get("sources") or []:
        if isinstance(source, dict):
            source.pop("path", None)
            source.pop("audioPath", None)
            source.pop("waveformPath", None)
            preview_path = source.pop("previewPath", None)
            source["originalUrl"] = (
                f'/api/studio/projects/{manifest["id"]}/assets/{source.get("id")}/original'
            )
            source["audioUrl"] = (
                f'/api/studio/projects/{manifest["id"]}/assets/{source.get("id")}/audio'
            )
            if preview_path:
                source["previewUrl"] = (
                    f'/api/studio/projects/{manifest["id"]}/assets/{source.get("id")}/preview'
                )
    for output in result.get("outputs") or []:
        if isinstance(output, dict):
            output.pop("path", None)
            output["contentUrl"] = (
                f'/api/studio/projects/{manifest["id"]}/assets/{output.get("id")}/content'
            )
            output["downloadUrl"] = (
                f'/api/studio/projects/{manifest["id"]}/outputs/{output.get("id")}/download'
            )
    result["diskBytes"] = _directory_size(project_dir(manifest["id"]))
    return result


def _purge_manifest_recordings(
    project_id: str,
    manifest: dict,
    *,
    now: float | None = None,
) -> tuple[bool, int]:
    from .recordings import _delete_source_files, _is_managed_recording, _source_expiry
    checked_at = time.time() if now is None else float(now)
    changed = False
    removed = 0
    retained = []
    for source in manifest.get("sources") or []:
        if not isinstance(source, dict) or not _is_managed_recording(source):
            retained.append(source)
            continue
        expiry = _source_expiry(source)
        if source.get("captureMethod") != "recording":
            source["captureMethod"] = "recording"
            changed = True
        if expiry > 0 and source.get("expiresAt") != expiry:
            source["expiresAt"] = expiry
            changed = True
        if expiry > 0 and expiry <= checked_at:
            if not _delete_source_files(project_id, source):
                retained.append(source)
                continue
            removed += 1
            changed = True
            continue
        retained.append(source)
    if removed:
        manifest["sources"] = retained
    return changed, removed
