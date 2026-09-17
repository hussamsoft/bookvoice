"""Job orchestration: submit, progress, cancel, and lookup.

Studio jobs (NARRATION, CONVERSION, REPAIR) run on a bounded
``ThreadPoolExecutor`` that carries the request's device owner into
each worker via ``copy_context()``. ``cancel_job`` flips a per-job
``threading.Event``; the worker checks it at the next opportunity.
"""
from __future__ import annotations

import copy
import threading
import time
import uuid
from contextvars import copy_context

from . import manifest as _manifest
from .devices import current_device_id  # noqa: F401  (re-exported for compat)


WORKFLOWS = {"NARRATION", "CONVERSION", "REPAIR"}


def _find_job(manifest: dict, job_id: str) -> dict:
    safe_job_id = _manifest._validate_job_id(job_id)
    for job in manifest.get("jobs") or []:
        if isinstance(job, dict) and job.get("id") == safe_job_id:
            return job
    raise FileNotFoundError("Studio job was not found.")


def _patch_job(project_id: str, job_id: str, changes: dict) -> dict:
    safe_id = _manifest._validate_project_id(project_id)
    with _manifest._project_lock(safe_id):
        manifest = _manifest._load_manifest(safe_id, normalize_jobs=False)
        job = _find_job(manifest, job_id)
        job.update(copy.deepcopy(changes))
        job["updatedAt"] = time.time()
        manifest["updatedAt"] = time.time()
        _manifest._write_json_atomic(_manifest._manifest_path(safe_id), manifest)
        return copy.deepcopy(job)


def update_job_progress(project_id: str, job_id: str, progress: float, message: str = "") -> dict:
    value = max(0.0, min(0.99, float(progress)))
    return _patch_job(
        project_id,
        job_id,
        {"progress": round(value, 4), "message": str(message or "")[:300]},
    )


def submit_job(project_id: str, kind: str, function, *args, **kwargs) -> dict:
    from .projects import get_project
    safe_id = _manifest._validate_project_id(project_id)
    get_project(safe_id)
    job_id = uuid.uuid4().hex
    now = time.time()
    job = {
        "id": job_id,
        "projectId": safe_id,
        "kind": str(kind or "STUDIO").upper(),
        "status": "QUEUED",
        "progress": 0.0,
        "message": "Queued",
        "canRetry": False,
        "createdAt": now,
        "updatedAt": now,
    }
    event = threading.Event()
    # Bookkeeping must roll back if the manifest write below fails; otherwise
    # the cancellation entry dangles in memory for a job that does not exist
    # on disk.
    with _manifest._jobs_guard:
        _manifest._job_cancellations[job_id] = event
        _manifest._active_job_ids.add(job_id)
    try:
        with _manifest._project_lock(safe_id):
            manifest = _manifest._load_manifest(safe_id, normalize_jobs=False)
            manifest.setdefault("jobs", []).append(job)
            manifest["updatedAt"] = now
            _manifest._write_json_atomic(_manifest._manifest_path(safe_id), manifest)
    except Exception:
        with _manifest._jobs_guard:
            _manifest._job_cancellations.pop(job_id, None)
            _manifest._active_job_ids.discard(job_id)
        raise

    def run():
        try:
            _patch_job(safe_id, job_id, {"status": "RUNNING", "message": "Working"})
            result = function(*args, job_id=job_id, cancel_event=event, **kwargs)
            if event.is_set():
                _patch_job(
                    safe_id,
                    job_id,
                    {"status": "CANCELLED", "message": "Cancelled", "canRetry": True},
                )
            else:
                _patch_job(
                    safe_id,
                    job_id,
                    {
                        "status": "COMPLETED",
                        "progress": 1.0,
                        "message": "Completed",
                        "result": copy.deepcopy(result),
                    },
                )
        except Exception as exc:  # noqa: BLE001 - job failures are persisted for the UI
            if event.is_set():
                _patch_job(
                    safe_id,
                    job_id,
                    {
                        "status": "CANCELLED",
                        "message": "Cancelled",
                        "canRetry": True,
                    },
                )
            else:
                _patch_job(
                    safe_id,
                    job_id,
                    {
                        "status": "FAILED",
                        "message": str(exc)[:500],
                        "error": {
                            "code": "STUDIO_JOB_FAILED",
                            "message": str(exc)[:500],
                        },
                        "canRetry": True,
                    },
                )
        finally:
            with _manifest._jobs_guard:
                _manifest._active_job_ids.discard(job_id)
                _manifest._job_cancellations.pop(job_id, None)

    # ThreadPoolExecutor does not propagate ContextVars by itself. Carry the
    # request's device owner into every background media job so later manifest
    # and asset writes remain inside the same device boundary.
    context = _manifest.copy_context() if hasattr(_manifest, "copy_context") else copy_context()
    _manifest._executor.submit(context.run, run)
    return copy.deepcopy(job)


def get_job(job_id: str) -> dict:
    safe_job_id = _manifest._validate_job_id(job_id)
    for project in (_manifest.studio_root() / "projects").iterdir():
        if not project.is_dir() or not _manifest.PROJECT_ID_RE.fullmatch(project.name):
            continue
        try:
            manifest = _manifest._load_manifest(project.name, normalize_jobs=False)
            return copy.deepcopy(_find_job(manifest, safe_job_id))
        except FileNotFoundError:
            continue
    raise FileNotFoundError("Studio job was not found.")


def cancel_job(job_id: str) -> dict:
    job = get_job(job_id)
    if job.get("status") in {"COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"}:
        return job
    with _manifest._jobs_guard:
        event = _manifest._job_cancellations.get(job["id"])
        if event:
            event.set()
    return _patch_job(
        job["projectId"],
        job["id"],
        {"status": "CANCELLED", "message": "Cancelling", "canRetry": True},
    )
