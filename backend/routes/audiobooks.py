"""Chaptered M4B audiobook export routes for prepared books."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from services import audiobook_export_service as exports

router = APIRouter()


class AudiobookCreate(BaseModel):
    profileId: str = Field(..., min_length=1, max_length=64)


def _error(code: str, message: str, status: int = 400):
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


@router.post("/{book_id}/audiobooks", status_code=201)
async def create_audiobook(book_id: str, request: AudiobookCreate):
    try:
        job = exports.create_audiobook_export(book_id, request.profileId)
    except exports.NoPreparedAudioError as exc:
        _error("AUDIOBOOK_REJECTED", str(exc), 409)
    except (ValueError, FileNotFoundError) as exc:
        _error("BOOK_NOT_FOUND", str(exc), 404)
    return {"jobId": job["id"], "status": job["status"], "pageCount": job["pageCount"]}


@router.get("/{book_id}/audiobooks/{job_id}")
async def get_audiobook(book_id: str, job_id: str):
    try:
        job = exports.get_audiobook_job(book_id, job_id)
    except FileNotFoundError as exc:
        _error("AUDIOBOOK_NOT_FOUND", str(exc), 404)
    payload = {
        key: value
        for key, value in job.items()
        if key in {"id", "bookId", "profileId", "status", "pagesDone", "pageCount", "error"}
    }
    if payload.get("error") is None:
        payload.pop("error", None)
    if job["status"] == "COMPLETED":
        payload["downloadUrl"] = (
            f"/api/books/{book_id}/audiobooks/{job_id}/content"
        )
    return payload


@router.delete("/{book_id}/audiobooks/{job_id}", status_code=204)
async def cancel_or_delete_audiobook(book_id: str, job_id: str):
    try:
        exports.cancel_or_delete_audiobook_job(book_id, job_id)
    except FileNotFoundError as exc:
        _error("AUDIOBOOK_NOT_FOUND", str(exc), 404)


@router.get("/{book_id}/audiobooks/{job_id}/content")
async def download_audiobook(book_id: str, job_id: str):
    try:
        job, path = exports.resolve_output_path(book_id, job_id)
    except FileNotFoundError as exc:
        _error("AUDIOBOOK_NOT_FOUND", str(exc), 404)
    safe_title = str(job.get("title") or "audiobook").replace("/", "-").replace("\\", "-")
    filename = f"{safe_title}-{job['profileId'][:8]}.m4b"
    return FileResponse(
        path,
        media_type="audio/mp4",
        filename=filename,
        background=BackgroundTask(exports.discard_downloaded_job, book_id, job_id),
    )
