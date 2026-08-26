"""Chaptered M4B audiobook export jobs for prepared books."""
from __future__ import annotations

import os
import threading
import time
import uuid
from pathlib import Path

from services import book_library_service as library
from services import media_tools


class NoPreparedAudioError(ValueError):
    """Raised when a book has no usable prepared narration for a profile."""


_lock = threading.RLock()
_jobs: dict[str, dict] = {}
RUNTIME_RECORD_TTL_SECONDS = 24 * 3600
FFPROBE_TIMEOUT_SECONDS = 120
FFMPEG_TIMEOUT_SECONDS = 1800


def _prune_runtime_records() -> None:
    cutoff = time.time() - RUNTIME_RECORD_TTL_SECONDS
    with _lock:
        for job_id, job in list(_jobs.items()):
            ended_at = job.get("endedAt")
            if ended_at and ended_at < cutoff:
                _jobs.pop(job_id, None)


def _update_job(job: dict, **changes) -> None:
    with _lock:
        job.update(changes)


def _cancel_requested(job: dict) -> bool:
    with _lock:
        return bool(job.get("cancelRequested"))


def create_audiobook_export(book_id: str, profile_id: str) -> dict:
    """Validate inputs, collect prepared pages, and spawn an export job thread."""
    _prune_runtime_records()
    # Malformed ids raise ValueError here; a missing book raises FileNotFoundError
    # from get_book. Routes map both to HTTP 404.
    directory = library.book_dir(book_id)
    library.page_audio_path(book_id, profile_id, 1)
    manifest = library.get_book(book_id)
    page_count = int(manifest.get("pageCount") or 0)
    pages: list[int] = []
    skipped_pages: list[int] = []
    for page in range(1, page_count + 1):
        if library.has_valid_page_audio(book_id, profile_id, page):
            pages.append(page)
        else:
            skipped_pages.append(page)
    if not pages:
        raise NoPreparedAudioError(
            "No prepared page audio was found for this narration profile."
        )

    job = {
        "id": uuid.uuid4().hex,
        "bookId": book_id,
        "profileId": profile_id,
        "bookDir": str(directory),
        "title": manifest.get("title") or "Untitled book",
        "status": "QUEUED",
        "pagesDone": 0,
        "pageCount": len(pages),
        "pages": pages,
        "skippedPages": skipped_pages,
        "createdAt": int(time.time()),
        "endedAt": None,
        "error": None,
        "outputPath": None,
        "tempPaths": [],
        "cancelRequested": False,
    }
    with _lock:
        _jobs[job["id"]] = job
    # Snapshot the public view before the worker can flip status to RUNNING,
    # so the create response always reports the contractual initial state.
    response = _public_job(job)
    thread = threading.Thread(target=_run_export, args=(job["id"],), daemon=True)
    thread.start()
    return response

def get_audiobook_job(book_id: str, job_id: str) -> dict:
    with _lock:
        job = _jobs.get(job_id)
        if job is None or job.get("bookId") != book_id:
            raise FileNotFoundError("Audiobook export job was not found.")
        return _public_job(job)


def cancel_or_delete_audiobook_job(book_id: str, job_id: str) -> None:
    """Cancel a running job, or remove a finished one together with its file."""
    with _lock:
        job = _jobs.get(job_id)
        if job is None or job.get("bookId") != book_id:
            raise FileNotFoundError("Audiobook export job was not found.")
        if job.get("status") in {"QUEUED", "RUNNING"}:
            job["cancelRequested"] = True
            return
        _jobs.pop(job_id, None)
    Path(str(job.get("outputPath") or "")).unlink(missing_ok=True)


def discard_downloaded_job(book_id: str, job_id: str) -> None:
    """One-shot download teardown: drop the record and its output file."""
    with _lock:
        job = _jobs.get(job_id)
        if job is None or job.get("bookId") != book_id:
            return
        _jobs.pop(job_id, None)
        path = Path(str(job.get("outputPath") or ""))
    path.unlink(missing_ok=True)


def resolve_output_path(book_id: str, job_id: str) -> tuple[dict, Path]:
    with _lock:
        job = _jobs.get(job_id)
        if job is None or job.get("bookId") != book_id:
            raise FileNotFoundError("Audiobook export job was not found.")
        if job.get("status") != "COMPLETED" or not job.get("outputPath"):
            raise FileNotFoundError("Audiobook export file is not ready.")
        return _public_job(job), Path(str(job["outputPath"]))


def _run_export(job_id: str) -> None:
    with _lock:
        job = _jobs.get(job_id)
    if job is None:
        return
    try:
        _update_job(job, status="RUNNING")
        durations = _measure_page_durations(job)
        output_path = _render_m4b(job, durations)
        _update_job(
            job,
            status="COMPLETED",
            outputPath=str(output_path),
            endedAt=time.time(),
        )
    except media_tools.MediaToolCancelled:
        _cleanup_temp_files(job)
        _update_job(job, status="CANCELLED", endedAt=time.time())
    except Exception as exc:  # noqa: BLE001 - surfaced redacted to the client
        _cleanup_temp_files(job)
        _update_job(
            job,
            status="FAILED",
            error=media_tools.redact_media_error(exc),
            endedAt=time.time(),
        )


def _measure_page_durations(job: dict) -> list[tuple[int, int]]:
    """Probe each prepared page's real duration in milliseconds via ffprobe."""
    durations: list[tuple[int, int]] = []
    for page in list(job["pages"]):
        if _cancel_requested(job):
            raise media_tools.MediaToolCancelled("ffmpeg was cancelled.")
        audio_path = library.page_audio_path(job["bookId"], job["profileId"], page)
        stdout = media_tools.run_media_tool(
            "ffprobe",
            [
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(audio_path),
            ],
            timeout=FFPROBE_TIMEOUT_SECONDS,
            cancel_check=lambda job=job: _cancel_requested(job),
        )
        seconds = float(stdout.strip().splitlines()[-1])
        durations.append((page, max(1, round(seconds * 1000))))
        _update_job(job, pagesDone=len(durations))
    return durations


def _render_m4b(job: dict, durations: list[tuple[int, int]]) -> Path:
    book_dir = Path(str(job["bookDir"]))
    export_dir = book_dir / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)
    stem = job["id"][:12]
    list_path = export_dir / f".tmp-{stem}-list.txt"
    meta_path = export_dir / f".tmp-{stem}-meta.txt"
    temp_output = export_dir / f".tmp-{stem}.m4b"
    final_output = export_dir / f"{stem}.m4b"
    try:
        list_path.write_text(_build_concat_file(job), encoding="utf-8")
        meta_path.write_text(_build_ffmetadata(job, durations), encoding="utf-8")
        with _lock:
            job["tempPaths"] = [str(list_path), str(meta_path), str(temp_output)]
        media_tools.run_media_tool(
            "ffmpeg",
            [
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(list_path),
                "-i",
                str(meta_path),
                "-map_metadata",
                "1",
                "-c:a",
                "aac",
                "-b:a",
                "96k",
                "-vn",
                str(temp_output),
            ],
            timeout=FFMPEG_TIMEOUT_SECONDS,
            cancel_check=lambda: _cancel_requested(job),
        )
        if _cancel_requested(job):
            raise media_tools.MediaToolCancelled("ffmpeg was cancelled.")
        os.replace(temp_output, final_output)
        return final_output
    finally:
        list_path.unlink(missing_ok=True)
        meta_path.unlink(missing_ok=True)
        temp_output.unlink(missing_ok=True)
        with _lock:
            job["tempPaths"] = []


def _cleanup_temp_files(job: dict) -> None:
    with _lock:
        paths = [Path(item) for item in (job.pop("tempPaths", None) or [])]
    for path in paths:
        path.unlink(missing_ok=True)


def _build_concat_file(job: dict) -> str:
    lines = ["ffconcat version 1.0"]
    for page in job["pages"]:
        audio_path = library.page_audio_path(job["bookId"], job["profileId"], page)
        lines.append(f"file {_quote_concat_path(str(audio_path.resolve()))}")
    return "\n".join(lines) + "\n"


def _quote_concat_path(path: str) -> str:
    """Single-quote a path for the ffmpeg concat demuxer."""
    normalized = Path(path).as_posix()
    return "'" + normalized.replace("'", "'\\''") + "'"


_FFMETADATA_SPECIALS = ("\\", ";", "#", "=", "\n")


def _ffmetadata_escape(value: str) -> str:
    text = str(value or "")
    for char in _FFMETADATA_SPECIALS:
        text = text.replace(char, "\\" + ("n" if char == "\n" else char))
    return text


def _build_ffmetadata(job: dict, durations: list[tuple[int, int]]) -> str:
    title = _ffmetadata_escape(job["title"])
    lines = [
        ";FFMETADATA1",
        f"title={title}",
        "artist=BookVoice",
        f"album={title}",
    ]
    cursor_ms = 0
    for page, length_ms in durations:
        start_ms = cursor_ms
        cursor_ms += length_ms
        lines.extend(
            [
                "[CHAPTER]",
                "TIMEBASE=1/1000",
                f"START={start_ms}",
                f"END={cursor_ms}",
                f"title=Page {page}",
            ]
        )
    return "\n".join(lines) + "\n"

def _public_job(job: dict) -> dict:
    """Return export state without worker-only runtime fields."""
    with _lock:
        payload = {
            key: value
            for key, value in job.items()
            if key not in {"outputPath", "pages", "bookDir", "tempPaths", "cancelRequested"}
        }
    return payload
