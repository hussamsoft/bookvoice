"""Persistent local Voice Studio projects and media workflows."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import shutil
import struct
import tempfile
import threading
import time
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from services.path_utils import (
    validate_language_id,
    validate_narration_text_length,
    validate_voice_id,
)
from services import media_tools


SCHEMA_VERSION = 1
PROJECT_ID_RE = re.compile(r"^[0-9a-f]{32}$")
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
PROJECT_NAME_MAX = 100
SCRIPT_MAX_CHARS = 200_000
MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024
MAX_SOURCE_DURATION_SEC = 6 * 60 * 60
MEDIA_EXTENSIONS = {
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".webm",
    ".mp4", ".mov", ".mkv",
}
DEFAULT_GENERATION_SETTINGS = {
    "pace": 1.0,
    "expression": 0.5,
    "temperature": 0.8,
    "guidance": None,
    "seed": None,
}

_locks_guard = threading.Lock()
_project_locks: dict[str, threading.RLock] = {}
_jobs_guard = threading.Lock()
_job_cancellations: dict[str, threading.Event] = {}
_active_job_ids: set[str] = set()
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="bookvoice-studio-media")


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
        os.replace(temp_path, path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _new_manifest(project_id: str, name: str) -> dict:
    now = time.time()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "id": project_id,
        "name": _clean_name(name),
        "createdAt": now,
        "updatedAt": now,
        "activeWorkflow": "NARRATION",
        "script": "",
        "languageId": "en",
        "voiceId": None,
        "generationSettings": dict(DEFAULT_GENERATION_SETTINGS),
        "sources": [],
        "outputs": [],
        "repairs": [],
        "jobs": [],
    }


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


def _load_manifest(project_id: str, *, normalize_jobs: bool = True) -> dict:
    path = _manifest_path(project_id)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise FileNotFoundError("Studio project was not found.") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("Studio project metadata is unavailable.") from exc
    if not isinstance(raw, dict) or raw.get("id") != project_id:
        raise RuntimeError("Studio project metadata is invalid.")
    if int(raw.get("schemaVersion") or 0) != SCHEMA_VERSION:
        raise RuntimeError("Studio project uses an unsupported schema version.")
    if normalize_jobs and _normalize_interrupted_jobs(raw):
        _write_json_atomic(path, raw)
    return raw


def _public_project(manifest: dict) -> dict:
    result = copy.deepcopy(manifest)
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
    result["diskBytes"] = _directory_size(project_dir(manifest["id"]))
    return result


def _directory_size(root: Path) -> int:
    total = 0
    try:
        for path in root.rglob("*"):
            if path.is_file():
                total += path.stat().st_size
    except OSError:
        pass
    return total


def create_project(name: str = "Untitled project") -> dict:
    project_id = uuid.uuid4().hex
    target = project_dir(project_id)
    target.mkdir(parents=False, exist_ok=False)
    for child in ("sources", "derived", "outputs"):
        (target / child).mkdir()
    manifest = _new_manifest(project_id, name)
    _write_json_atomic(target / "manifest.json", manifest)
    return _public_project(manifest)


def list_projects() -> list[dict]:
    projects = []
    for candidate in (studio_root() / "projects").iterdir():
        if not candidate.is_dir() or not PROJECT_ID_RE.fullmatch(candidate.name):
            continue
        try:
            projects.append(_public_project(_load_manifest(candidate.name)))
        except (FileNotFoundError, RuntimeError, ValueError):
            continue
    projects.sort(key=lambda item: float(item.get("updatedAt") or 0), reverse=True)
    return projects


def get_project(project_id: str) -> dict:
    safe_id = _validate_project_id(project_id)
    with _project_lock(safe_id):
        return _public_project(_load_manifest(safe_id))


def update_project(project_id: str, changes: dict) -> dict:
    safe_id = _validate_project_id(project_id)
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
    with _project_lock(safe_id):
        manifest = _load_manifest(safe_id)
        if "name" in changes:
            manifest["name"] = _clean_name(changes["name"])
        if "script" in changes:
            script = str(changes["script"] or "")
            if len(script) > SCRIPT_MAX_CHARS:
                raise ValueError(f"Studio scripts may not exceed {SCRIPT_MAX_CHARS} characters.")
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
            if workflow not in {"NARRATION", "REPAIR"}:
                raise ValueError("Invalid Studio workflow.")
            manifest["activeWorkflow"] = workflow
        manifest["updatedAt"] = time.time()
        _write_json_atomic(_manifest_path(safe_id), manifest)
        return _public_project(manifest)


def duplicate_project(project_id: str) -> dict:
    source_id = _validate_project_id(project_id)
    with _project_lock(source_id):
        original = _load_manifest(source_id)
        copied_id = uuid.uuid4().hex
        destination = project_dir(copied_id)
        shutil.copytree(project_dir(source_id), destination)
        copied = copy.deepcopy(original)
        now = time.time()
        copied["id"] = copied_id
        copied["name"] = _clean_name(f'{original["name"]} copy')
        copied["createdAt"] = now
        copied["updatedAt"] = now
        copied["jobs"] = []
        _write_json_atomic(destination / "manifest.json", copied)
        return _public_project(copied)


def delete_project(project_id: str) -> None:
    safe_id = _validate_project_id(project_id)
    target = project_dir(safe_id)
    if not target.is_dir():
        raise FileNotFoundError("Studio project was not found.")
    with _project_lock(safe_id):
        resolved_root = (studio_root() / "projects").resolve()
        resolved_target = target.resolve()
        if resolved_target.parent != resolved_root:
            raise ValueError("Invalid Studio project path.")
        shutil.rmtree(resolved_target)
    with _locks_guard:
        _project_locks.pop(safe_id, None)


def reset_runtime_state_for_tests() -> None:
    with _jobs_guard:
        for event in _job_cancellations.values():
            event.set()
        _job_cancellations.clear()
        _active_job_ids.clear()
    with _locks_guard:
        _project_locks.clear()


def _find_job(manifest: dict, job_id: str) -> dict:
    safe_job_id = _validate_job_id(job_id)
    for job in manifest.get("jobs") or []:
        if isinstance(job, dict) and job.get("id") == safe_job_id:
            return job
    raise FileNotFoundError("Studio job was not found.")


def _patch_job(project_id: str, job_id: str, changes: dict) -> dict:
    safe_id = _validate_project_id(project_id)
    with _project_lock(safe_id):
        manifest = _load_manifest(safe_id, normalize_jobs=False)
        job = _find_job(manifest, job_id)
        job.update(copy.deepcopy(changes))
        job["updatedAt"] = time.time()
        manifest["updatedAt"] = time.time()
        _write_json_atomic(_manifest_path(safe_id), manifest)
        return copy.deepcopy(job)


def update_job_progress(project_id: str, job_id: str, progress: float, message: str = "") -> dict:
    value = max(0.0, min(0.99, float(progress)))
    return _patch_job(
        project_id,
        job_id,
        {"progress": round(value, 4), "message": str(message or "")[:300]},
    )


def submit_job(project_id: str, kind: str, function, *args, **kwargs) -> dict:
    safe_id = _validate_project_id(project_id)
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
    with _jobs_guard:
        _job_cancellations[job_id] = event
        _active_job_ids.add(job_id)
    with _project_lock(safe_id):
        manifest = _load_manifest(safe_id, normalize_jobs=False)
        manifest.setdefault("jobs", []).append(job)
        manifest["updatedAt"] = now
        _write_json_atomic(_manifest_path(safe_id), manifest)

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
            with _jobs_guard:
                _active_job_ids.discard(job_id)
                _job_cancellations.pop(job_id, None)

    _executor.submit(run)
    return copy.deepcopy(job)


def get_job(job_id: str) -> dict:
    safe_job_id = _validate_job_id(job_id)
    for project in (studio_root() / "projects").iterdir():
        if not project.is_dir() or not PROJECT_ID_RE.fullmatch(project.name):
            continue
        try:
            manifest = _load_manifest(project.name, normalize_jobs=False)
            return copy.deepcopy(_find_job(manifest, safe_job_id))
        except FileNotFoundError:
            continue
    raise FileNotFoundError("Studio job was not found.")


def cancel_job(job_id: str) -> dict:
    job = get_job(job_id)
    if job.get("status") in {"COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"}:
        return job
    with _jobs_guard:
        event = _job_cancellations.get(job["id"])
        if event:
            event.set()
    return _patch_job(
        job["projectId"],
        job["id"],
        {"status": "CANCELLED", "message": "Cancelling", "canRetry": True},
    )


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


def _media_tool_path(name: str) -> str:
    return media_tools.media_tool_path(name)


def _redact_media_error(message: str) -> str:
    return media_tools.redact_media_error(message)


def _run_media_tool(name: str, args: list[str], timeout: int = 300) -> str:
    return media_tools.run_media_tool(name, args, timeout)


def _probe_media(path: Path) -> dict:
    raw = _run_media_tool(
        "ffprobe",
        [
            "-v", "error", "-show_entries",
            "format=duration,format_name:stream=codec_type,sample_rate,channels",
            "-of", "json", str(path),
        ],
        timeout=60,
    )
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("Media metadata could not be read.") from exc
    streams = payload.get("streams") if isinstance(payload, dict) else None
    streams = streams if isinstance(streams, list) else []
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if not audio:
        raise ValueError("Uploaded media does not contain an audio stream.")
    try:
        duration = float((payload.get("format") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0
    if duration <= 0:
        raise ValueError("Uploaded media has no measurable duration.")
    if duration > MAX_SOURCE_DURATION_SEC:
        raise ValueError("Studio media may not exceed six hours.")
    return {
        "durationSec": round(duration, 4),
        "hasVideo": any(stream.get("codec_type") == "video" for stream in streams),
        "sampleRate": int(audio.get("sample_rate") or 24_000),
        "channels": max(1, min(2, int(audio.get("channels") or 1))),
        "formatName": str((payload.get("format") or {}).get("format_name") or "unknown"),
    }


def _extract_edit_audio(source: Path, target: Path, *, sample_rate: int, channels: int) -> None:
    temp = target.with_suffix(".wav.tmp")
    try:
        _run_media_tool(
            "ffmpeg",
            [
                "-y", "-v", "error", "-i", str(source), "-map", "0:a:0", "-vn",
                "-ac", str(channels), "-ar", str(sample_rate), "-c:a", "pcm_s16le",
                "-f", "wav", str(temp),
            ],
        )
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)


def _create_video_preview(source: Path, target: Path) -> None:
    """Create an H.264/AAC MP4 proxy that the embedded Chromium can decode."""
    temp = target.with_name(f".{target.stem}-building.mp4")
    try:
        _run_media_tool(
            "ffmpeg",
            [
                "-y", "-v", "error", "-i", str(source),
                "-map", "0:v:0", "-map", "0:a:0", "-sn", "-dn",
                "-vf", "scale=w='min(1280,iw)':h=-2:flags=lanczos,format=yuv420p",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                "-profile:v", "main", "-level:v", "4.0",
                "-c:a", "aac", "-b:a", "128k", "-ac", "2",
                "-movflags", "+faststart", "-max_muxing_queue_size", "1024",
                "-f", "mp4", str(temp),
            ],
            timeout=3600,
        )
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)


def _waveform_peaks(path: Path, buckets: int = 800) -> list[float]:
    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        width = source.getsampwidth()
        frames = source.getnframes()
        if width != 2 or frames <= 0:
            raise ValueError("Studio edit audio must be 16-bit PCM WAV.")
        frames_per_bucket = max(1, frames // buckets)
        peaks = []
        while len(peaks) < buckets:
            raw = source.readframes(frames_per_bucket)
            if not raw:
                break
            samples = struct.iter_unpack("<h", raw)
            peak = max((abs(value[0]) for value in samples), default=0) / 32768.0
            peaks.append(round(min(1.0, peak), 4))
    return peaks


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def import_source_path(project_id: str, staged: Path, filename: str) -> dict:
    safe_id = _validate_project_id(project_id)
    staged = Path(staged)
    if not staged.is_file() or staged.stat().st_size <= 0:
        raise ValueError("Uploaded media is empty.")
    if staged.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("Studio media may not exceed 2 GB.")
    extension = Path(filename or "").suffix.lower()
    if extension not in MEDIA_EXTENSIONS:
        raise ValueError("Unsupported media type.")
    metadata = _probe_media(staged)
    source_id = uuid.uuid4().hex
    target_root = project_dir(safe_id)
    target = target_root / "sources" / f"{source_id}{extension}"
    temp_target = target.with_suffix(f"{extension}.tmp")
    audio = target_root / "derived" / f"{source_id}.wav"
    preview = target_root / "derived" / f"{source_id}-preview.mp4" if metadata["hasVideo"] else None
    waveform_path = target_root / "derived" / f"{source_id}-waveform.json"
    try:
        with staged.open("rb") as input_handle, temp_target.open("wb") as output_handle:
            shutil.copyfileobj(input_handle, output_handle, length=1024 * 1024)
            output_handle.flush()
            os.fsync(output_handle.fileno())
        os.replace(temp_target, target)
        _extract_edit_audio(
            target,
            audio,
            sample_rate=metadata["sampleRate"],
            channels=metadata["channels"],
        )
        if preview is not None:
            _create_video_preview(target, preview)
        peaks = _waveform_peaks(audio)
        _write_json_atomic(waveform_path, peaks)
    except Exception:
        temp_target.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        audio.unlink(missing_ok=True)
        waveform_path.unlink(missing_ok=True)
        if preview is not None:
            preview.unlink(missing_ok=True)
        raise

    record = {
        "id": source_id,
        "fileName": Path(filename).name,
        "mediaType": "VIDEO" if metadata["hasVideo"] else "AUDIO",
        "durationSec": metadata["durationSec"],
        "sampleRate": metadata["sampleRate"],
        "channels": metadata["channels"],
        "formatName": metadata["formatName"],
        "sizeBytes": target.stat().st_size,
        "sha256": _sha256_file(target),
        "waveformPeaks": peaks,
        "path": str(target.relative_to(target_root)).replace("\\", "/"),
        "audioPath": str(audio.relative_to(target_root)).replace("\\", "/"),
        "waveformPath": str(waveform_path.relative_to(target_root)).replace("\\", "/"),
        "createdAt": time.time(),
    }
    if preview is not None:
        record["previewPath"] = str(preview.relative_to(target_root)).replace("\\", "/")
    with _project_lock(safe_id):
        manifest = _load_manifest(safe_id)
        manifest.setdefault("sources", []).append(record)
        manifest["updatedAt"] = time.time()
        _write_json_atomic(_manifest_path(safe_id), manifest)
    return _public_project(manifest)["sources"][-1]


def asset_path(project_id: str, asset_id: str, variant: str = "content") -> Path:
    safe_id = _validate_project_id(project_id)
    if not PROJECT_ID_RE.fullmatch(str(asset_id or "")):
        raise ValueError("Invalid Studio asset id.")
    manifest = _load_manifest(safe_id)
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
    root = project_dir(safe_id).resolve()
    target = (root / str(relative)).resolve()
    if root not in target.parents or not target.is_file():
        raise FileNotFoundError("Studio asset was not found.")
    return target


def _windows_downloads_dir() -> Path:
    if os.name == "nt":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            ) as key:
                raw = winreg.QueryValueEx(
                    key, "{374DE290-123F-4565-9164-39C4925E467B}"
                )[0]
            target = Path(os.path.expandvars(str(raw))).expanduser()
        except (OSError, ValueError):
            target = Path.home() / "Downloads"
    else:
        target = Path.home() / "Downloads"
    target.mkdir(parents=True, exist_ok=True)
    if not target.is_dir():
        raise RuntimeError("The Windows Downloads folder is unavailable.")
    return target.resolve()


def _download_file_name(value: str, output_id: str) -> str:
    supplied = Path(str(value or "")).name
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", supplied).strip(" .")
    return cleaned or f"bookvoice-{output_id[:8]}.wav"


def _is_cancelled(event: threading.Event | None) -> bool:
    return bool(event and event.is_set())


def save_output_to_downloads(
    project_id: str,
    output_id: str,
    *,
    cancel_event: threading.Event | None = None,
    progress=None,
) -> dict:
    safe_id = _validate_project_id(project_id)
    if not PROJECT_ID_RE.fullmatch(str(output_id or "")):
        raise ValueError("Invalid Studio output id.")
    with _project_lock(safe_id):
        manifest = _load_manifest(safe_id, normalize_jobs=False)
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
    source = asset_path(safe_id, output_id, "content")
    expected_sha = str(output.get("sha256") or _sha256_file(source))
    destination = _windows_downloads_dir()
    requested_name = _download_file_name(output.get("fileName"), output_id)
    stem = Path(requested_name).stem
    suffix = Path(requested_name).suffix
    target = None
    handle = None
    for index in range(10_000):
        name = requested_name if index == 0 else f"{stem} ({index}){suffix}"
        candidate = destination / name
        try:
            descriptor = os.open(
                candidate,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0),
                0o600,
            )
            target = candidate
            handle = os.fdopen(descriptor, "wb")
            break
        except FileExistsError:
            continue
    if target is None or handle is None:
        raise RuntimeError("Could not reserve a unique file in Downloads.")

    copied = 0
    total = max(1, source.stat().st_size)
    try:
        if _is_cancelled(cancel_event):
            raise RuntimeError("Output download was cancelled.")
        with handle as destination_handle, source.open("rb") as source_handle:
            handle = None
            for chunk in iter(lambda: source_handle.read(1024 * 1024), b""):
                if _is_cancelled(cancel_event):
                    raise RuntimeError("Output download was cancelled.")
                destination_handle.write(chunk)
                copied += len(chunk)
                if progress:
                    progress(min(0.98, copied / total))
            destination_handle.flush()
            os.fsync(destination_handle.fileno())
        if _sha256_file(target) != expected_sha:
            raise RuntimeError("Saved output did not match the generated file.")
    except Exception:
        if handle is not None:
            handle.close()
        target.unlink(missing_ok=True)
        raise
    return {
        "outputId": output_id,
        "fileName": target.name,
        "destination": "Downloads",
    }


def _open_directory(path: Path) -> None:
    if os.name != "nt" or not hasattr(os, "startfile"):
        raise OSError("Opening folders is available in the Windows desktop app.")
    os.startfile(str(path))  # type: ignore[attr-defined]


def open_project_folder(project_id: str) -> dict:
    safe_id = _validate_project_id(project_id)
    root = project_dir(safe_id).resolve()
    managed_root = (studio_root() / "projects").resolve()
    if root.parent != managed_root or not root.is_dir():
        raise FileNotFoundError("Studio project was not found.")
    _open_directory(root)
    return {"opened": True}


def _source_record(manifest: dict, source_id: str) -> dict:
    if not PROJECT_ID_RE.fullmatch(str(source_id or "")):
        raise ValueError("Invalid Studio source id.")
    for source in manifest.get("sources") or []:
        if isinstance(source, dict) and source.get("id") == source_id:
            return source
    raise FileNotFoundError("Studio source was not found.")


def _extract_profile_clip(source: Path, target: Path, *, start_sec: float, duration_sec: float) -> None:
    temp = target.with_suffix(".wav.tmp")
    try:
        _run_media_tool(
            "ffmpeg",
            [
                "-y", "-v", "error", "-ss", f"{start_sec:.4f}", "-i", str(source),
                "-t", f"{duration_sec:.4f}", "-map", "0:a:0", "-vn", "-ac", "1",
                "-ar", "24000", "-c:a", "pcm_s16le", "-f", "wav", str(temp),
            ],
            timeout=180,
        )
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)


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
    safe_id = _validate_project_id(project_id)
    with _project_lock(safe_id):
        manifest = _load_manifest(safe_id)
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
    root = project_dir(safe_id)
    original = (root / str(source.get("path") or "")).resolve()
    if root.resolve() not in original.parents or not original.is_file():
        raise FileNotFoundError("Studio source was not found.")

    fd, temp_name = tempfile.mkstemp(prefix="studio-profile-", suffix=".wav", dir=studio_root() / "staging")
    os.close(fd)
    clip = Path(temp_name)
    try:
        _extract_profile_clip(original, clip, start_sec=start, duration_sec=duration)
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


class _EventCancellation:
    def __init__(self, event: threading.Event | None):
        self._event = event

    def cancelled(self) -> bool:
        return bool(self._event and self._event.is_set())


def _copy_atomic(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}-", suffix=".tmp", dir=target.parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as output, source.open("rb") as input_handle:
            shutil.copyfileobj(input_handle, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, target)
    except Exception:
        temp.unlink(missing_ok=True)
        raise


def create_narration(
    project_id: str,
    text: str,
    language_id: str,
    voice_id: str | None,
    generation_settings: dict,
    *,
    cancel_event: threading.Event | None = None,
) -> dict:
    safe_id = _validate_project_id(project_id)
    script = validate_narration_text_length(text)
    language = validate_language_id(language_id)
    voice = validate_voice_id(voice_id) if voice_id else None
    settings = validate_generation_settings(generation_settings)
    get_project(safe_id)

    from services import tts_service

    session_id = f"studio-{safe_id}"
    cancellation = _EventCancellation(cancel_event)
    future = tts_service.submit_tts(
        tts_service.TtsPriority.CURRENT,
        tts_service.narrate_studio_text,
        script,
        session_id,
        voice,
        language,
        settings,
        cancellation,
    )
    generated = future.result()
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
    target = project_dir(safe_id) / "outputs" / f"{output_id}.wav"
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
        "fileName": f"{re.sub(r'[^A-Za-z0-9_-]+', '-', get_project(safe_id)['name']).strip('-') or 'narration'}.wav",
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
        "path": str(target.relative_to(project_dir(safe_id))).replace("\\", "/"),
        "createdAt": time.time(),
    }
    with _project_lock(safe_id):
        manifest = _load_manifest(safe_id, normalize_jobs=False)
        manifest["script"] = script
        manifest["languageId"] = language
        manifest["voiceId"] = voice
        manifest["generationSettings"] = settings
        manifest.setdefault("outputs", []).append(record)
        manifest["updatedAt"] = time.time()
        _write_json_atomic(_manifest_path(safe_id), manifest)
        return _public_project(manifest)["outputs"][-1]


def _asset_record(manifest: dict, asset_id: str) -> tuple[dict, str]:
    if not PROJECT_ID_RE.fullmatch(str(asset_id or "")):
        raise ValueError("Invalid Studio asset id.")
    for source in manifest.get("sources") or []:
        if source.get("id") == asset_id:
            return source, "SOURCE"
    for output in manifest.get("outputs") or []:
        if output.get("id") == asset_id:
            return output, "OUTPUT"
    raise FileNotFoundError("Studio asset was not found.")


def _fit_replacement(replacement, target_frames: int, sample_rate: int):
    import numpy as np

    audio = np.asarray(replacement, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio[:, None]
    if len(audio) < 2 or target_frames < 2:
        raise ValueError("Repair selection is too short.")
    rate = len(audio) / float(target_frames)
    if not 0.75 <= rate <= 1.25:
        raise ValueError(
            "The replacement differs too much from the selected duration. Adjust the selection or wording."
        )
    if abs(rate - 1.0) > 0.001:
        import torch
        import torchaudio as ta

        n_fft = 1024
        hop_length = 256
        window = torch.hann_window(n_fft)
        stretched = []
        for channel in range(audio.shape[1]):
            samples = torch.from_numpy(audio[:, channel])
            spectrum = torch.stft(
                samples,
                n_fft=n_fft,
                hop_length=hop_length,
                window=window,
                return_complex=True,
            )
            phase_advance = torch.linspace(
                0, math.pi * hop_length, spectrum.shape[-2]
            )[..., None]
            changed = ta.functional.phase_vocoder(spectrum, rate=rate, phase_advance=phase_advance)
            restored = torch.istft(
                changed,
                n_fft=n_fft,
                hop_length=hop_length,
                window=window,
                length=target_frames,
            )
            stretched.append(restored.numpy())
        audio = np.stack(stretched, axis=1)
    if len(audio) > target_frames:
        audio = audio[:target_frames]
    elif len(audio) < target_frames:
        audio = np.pad(audio, ((0, target_frames - len(audio)), (0, 0)))
    return audio.astype(np.float32, copy=False)


def _resample_and_match_channels(replacement, replacement_rate: int, sample_rate: int, channels: int):
    import numpy as np

    audio = np.asarray(replacement, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio[:, None]
    if replacement_rate != sample_rate:
        import torch
        import torchaudio as ta

        converted = ta.functional.resample(
            torch.from_numpy(audio.T), replacement_rate, sample_rate
        )
        audio = converted.numpy().T
    if audio.shape[1] != channels:
        mono = audio.mean(axis=1, keepdims=True)
        audio = np.repeat(mono, channels, axis=1)
    return audio


def _splice_replacement(source, replacement, start_frame: int, end_frame: int, sample_rate: int):
    import numpy as np

    result = np.asarray(source, dtype=np.float32).copy()
    original = result[start_frame:end_frame]
    patch = np.asarray(replacement, dtype=np.float32).copy()
    target_rms = float(np.sqrt(np.mean(original * original))) if original.size else 0.0
    patch_rms = float(np.sqrt(np.mean(patch * patch))) if patch.size else 0.0
    if target_rms > 0.0001 and patch_rms > 0.0001:
        patch *= max(0.25, min(4.0, target_rms / patch_rms))
    patch = np.clip(patch, -0.99, 0.99)
    fade = min(int(sample_rate * 0.03), len(patch) // 3)
    if fade > 1:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)[:, None]
        patch[:fade] = original[:fade] * (1.0 - ramp) + patch[:fade] * ramp
        patch[-fade:] = patch[-fade:] * (1.0 - ramp) + original[-fade:] * ramp
    result[start_frame:end_frame] = patch
    return result


def _read_wav_audio(path: Path):
    import numpy as np

    fmt = None
    data = None
    with Path(path).open("rb") as handle:
        header = handle.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise ValueError("Studio audio is not a valid WAV file.")
        while True:
            chunk_header = handle.read(8)
            if len(chunk_header) < 8:
                break
            chunk_id, chunk_size = struct.unpack("<4sI", chunk_header)
            payload = handle.read(chunk_size)
            if chunk_size & 1:
                handle.read(1)
            if chunk_id == b"fmt ":
                fmt = payload
            elif chunk_id == b"data":
                data = payload
    if fmt is None or data is None or len(fmt) < 16:
        raise ValueError("Studio audio is missing WAV format data.")
    audio_format, channels, sample_rate, _, block_align, bits = struct.unpack_from("<HHIIHH", fmt)
    if audio_format == 0xFFFE and len(fmt) >= 26:
        audio_format = struct.unpack_from("<H", fmt, 24)[0]
    if channels < 1 or block_align < 1:
        raise ValueError("Studio WAV channel metadata is invalid.")
    if audio_format == 3 and bits == 32:
        samples = np.frombuffer(data, dtype="<f4").astype(np.float32, copy=False)
    elif audio_format == 3 and bits == 64:
        samples = np.frombuffer(data, dtype="<f8").astype(np.float32)
    elif audio_format == 1 and bits == 16:
        samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    elif audio_format == 1 and bits == 32:
        samples = np.frombuffer(data, dtype="<i4").astype(np.float32) / 2147483648.0
    elif audio_format == 1 and bits == 8:
        samples = (np.frombuffer(data, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"Unsupported Studio WAV encoding ({audio_format}, {bits}-bit).")
    frame_count = len(samples) // channels
    return samples[: frame_count * channels].reshape(frame_count, channels), sample_rate


def _write_wav_pcm16(path: Path, audio, sample_rate: int) -> None:
    import numpy as np

    samples = np.asarray(audio, dtype=np.float32)
    if samples.ndim == 1:
        samples = samples[:, None]
    encoded = (np.clip(samples, -1.0, 0.999969) * 32768.0).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(samples.shape[1])
        output.setsampwidth(2)
        output.setframerate(int(sample_rate))
        output.writeframes(encoded.tobytes())


def _session_audio_path(session_id: str, audio_url: str) -> Path:
    prefix = f"/sessions/{session_id}/"
    if not str(audio_url or "").startswith(prefix):
        raise RuntimeError("Generated Studio audio path is invalid.")
    filename = str(audio_url)[len(prefix):]
    if not filename or Path(filename).name != filename:
        raise RuntimeError("Generated Studio audio path is invalid.")
    path = Path(os.environ.get("DATA_DIR", "data")) / "sessions" / session_id / filename
    if not path.is_file():
        raise FileNotFoundError("Generated Studio audio was not found.")
    return path


def create_repair(
    project_id: str,
    asset_id: str,
    start_sec: float,
    end_sec: float,
    replacement_text: str,
    language_id: str,
    voice_id: str | None,
    generation_settings: dict,
    *,
    cancel_event: threading.Event | None = None,
) -> dict:
    safe_id = _validate_project_id(project_id)
    text = validate_narration_text_length(replacement_text)
    language = validate_language_id(language_id)
    voice = validate_voice_id(voice_id) if voice_id else None
    settings = validate_generation_settings(generation_settings)
    with _project_lock(safe_id):
        manifest = _load_manifest(safe_id, normalize_jobs=False)
        asset, asset_kind = _asset_record(manifest, asset_id)
        asset = copy.deepcopy(asset)
    try:
        start = float(start_sec)
        end = float(end_sec)
    except (TypeError, ValueError) as exc:
        raise ValueError("Repair times must be numbers.") from exc
    if start < 0 or end - start < 0.25 or end - start > 20:
        raise ValueError("Select a repair range between 0.25 and 20 seconds.")
    duration = float(asset.get("durationSec") or 0)
    if duration and end > duration + 0.01:
        raise ValueError("Repair selection extends beyond the source audio.")

    from services import tts_service

    session_id = f"studio-{safe_id}"
    cancellation = _EventCancellation(cancel_event)
    future = tts_service.submit_tts(
        tts_service.TtsPriority.INTERACTIVE,
        tts_service.narrate_studio_repair_text,
        text,
        session_id,
        voice,
        language,
        settings,
        cancellation,
    )
    generated = future.result()
    if cancellation.cancelled():
        raise RuntimeError("Studio repair was cancelled.")
    replacement_path = _session_audio_path(session_id, generated.get("audio_url"))

    import numpy as np

    root = project_dir(safe_id)
    relative = asset.get("audioPath") if asset_kind == "SOURCE" else asset.get("path")
    master = (root / str(relative or "")).resolve()
    if root.resolve() not in master.parents or not master.is_file():
        raise FileNotFoundError("Studio repair source was not found.")
    source_audio, sample_rate = _read_wav_audio(master)
    replacement, replacement_rate = _read_wav_audio(replacement_path)
    replacement = _resample_and_match_channels(
        replacement, replacement_rate, sample_rate, source_audio.shape[1]
    )
    start_frame = max(0, int(round(start * sample_rate)))
    end_frame = min(len(source_audio), int(round(end * sample_rate)))
    replacement = _fit_replacement(replacement, end_frame - start_frame, sample_rate)
    repaired = _splice_replacement(
        source_audio, replacement, start_frame, end_frame, sample_rate
    )

    output_id = uuid.uuid4().hex
    target = root / "outputs" / f"{output_id}.wav"
    temp = target.with_suffix(".wav.tmp")
    try:
        _write_wav_pcm16(temp, repaired, sample_rate)
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    repair_id = uuid.uuid4().hex
    output = {
        "id": output_id,
        "kind": "REPAIR_AUDIO",
        "fileName": f"repaired-{output_id[:8]}.wav",
        "format": "WAV",
        "parentAssetId": asset_id,
        "repairId": repair_id,
        "durationSec": round(len(repaired) / float(sample_rate), 4),
        "sampleRate": sample_rate,
        "channels": int(repaired.shape[1]),
        "sizeBytes": target.stat().st_size,
        "sha256": _sha256_file(target),
        "path": str(target.relative_to(root)).replace("\\", "/"),
        "createdAt": time.time(),
    }
    repair = {
        "id": repair_id,
        "assetId": asset_id,
        "sourceKind": asset_kind,
        "startSec": round(start, 4),
        "endSec": round(end, 4),
        "replacementText": text,
        "languageId": language,
        "voiceId": voice,
        "generationSettings": settings,
        "outputId": output_id,
        "status": "PREVIEW_READY",
        "createdAt": time.time(),
    }
    with _project_lock(safe_id):
        manifest = _load_manifest(safe_id, normalize_jobs=False)
        manifest.setdefault("repairs", []).append(repair)
        manifest.setdefault("outputs", []).append(output)
        manifest["updatedAt"] = time.time()
        _write_json_atomic(_manifest_path(safe_id), manifest)
        public = _public_project(manifest)
        return {"repair": public["repairs"][-1], "output": public["outputs"][-1]}


def export_repair_video(project_id: str, repair_id: str) -> dict:
    safe_id = _validate_project_id(project_id)
    if not PROJECT_ID_RE.fullmatch(str(repair_id or "")):
        raise ValueError("Invalid Studio repair id.")
    with _project_lock(safe_id):
        manifest = _load_manifest(safe_id, normalize_jobs=False)
        repair = next(
            (item for item in manifest.get("repairs") or [] if item.get("id") == repair_id),
            None,
        )
        if repair is None:
            raise FileNotFoundError("Studio repair was not found.")
        source, source_kind = _asset_record(manifest, repair.get("assetId"))
        if source_kind != "SOURCE" or source.get("mediaType") != "VIDEO":
            raise ValueError("This repair does not have a video source.")
        repaired_audio, output_kind = _asset_record(manifest, repair.get("outputId"))
        if output_kind != "OUTPUT" or repaired_audio.get("kind") != "REPAIR_AUDIO":
            raise FileNotFoundError("Repaired audio was not found.")
        source = copy.deepcopy(source)
        repaired_audio = copy.deepcopy(repaired_audio)

    root = project_dir(safe_id)
    video_path = (root / str(source.get("path") or "")).resolve()
    audio_path = (root / str(repaired_audio.get("path") or "")).resolve()
    if root.resolve() not in video_path.parents or not video_path.is_file():
        raise FileNotFoundError("Studio video source was not found.")
    if root.resolve() not in audio_path.parents or not audio_path.is_file():
        raise FileNotFoundError("Repaired audio was not found.")

    output_id = uuid.uuid4().hex
    target = root / "outputs" / f"{output_id}.mp4"
    temp = target.with_suffix(".mp4.tmp")
    common = [
        "-y", "-v", "error", "-i", str(video_path), "-i", str(audio_path),
        "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", "-shortest",
    ]
    try:
        try:
            _run_media_tool(
                "ffmpeg", [*common, "-c:v", "copy", "-f", "mp4", str(temp)], timeout=900
            )
        except ValueError:
            temp.unlink(missing_ok=True)
            _run_media_tool(
                "ffmpeg",
                [
                    *common,
                    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-f", "mp4", str(temp),
                ],
                timeout=1800,
            )
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    output = {
        "id": output_id,
        "kind": "REPAIR_VIDEO",
        "fileName": f"repaired-{Path(source.get('fileName') or 'video').stem}.mp4",
        "format": "MP4",
        "parentAssetId": source["id"],
        "repairId": repair_id,
        "durationSec": float(repaired_audio.get("durationSec") or source.get("durationSec") or 0),
        "sizeBytes": target.stat().st_size,
        "sha256": _sha256_file(target),
        "path": str(target.relative_to(root)).replace("\\", "/"),
        "createdAt": time.time(),
    }
    with _project_lock(safe_id):
        manifest = _load_manifest(safe_id, normalize_jobs=False)
        repair = next(item for item in manifest["repairs"] if item.get("id") == repair_id)
        repair["status"] = "EXPORTED"
        repair["videoOutputId"] = output_id
        manifest.setdefault("outputs", []).append(output)
        manifest["updatedAt"] = time.time()
        _write_json_atomic(_manifest_path(safe_id), manifest)
        return _public_project(manifest)["outputs"][-1]
