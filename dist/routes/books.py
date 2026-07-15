"""Prepared-book library, generation jobs, and .bookvoice archives."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from services import book_library_service as library

router = APIRouter()
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024


class PageUpdate(BaseModel):
    text: str = Field(..., min_length=1, max_length=200_000)
    pageCount: int | None = Field(None, ge=1, le=9_999)


class ProgressUpdate(BaseModel):
    page: int = Field(1, ge=1, le=9_999)
    time: float = Field(0, ge=0)
    bookmarks: list[int] = []
    updatedAt: int | None = None


class PreparationCreate(BaseModel):
    voiceId: str | None = None
    languageId: str = "en"


class ArchiveCreate(BaseModel):
    profileId: str


def _error(code: str, message: str, status: int = 400):
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


async def _stage_upload(
    file: UploadFile,
    *,
    max_bytes: int = MAX_UPLOAD_BYTES,
    temp_dir: str | None = None,
) -> Path:
    """Copy an upload to disk with constant memory and strict size accounting."""
    fd, name = tempfile.mkstemp(prefix="bookvoice-upload-", suffix=".tmp", dir=temp_dir)
    path = Path(name)
    total = 0
    try:
        with os.fdopen(fd, "wb") as destination:
            while True:
                chunk = await file.read(UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("Book file is too large.")
                destination.write(chunk)
        return path
    except Exception:
        path.unlink(missing_ok=True)
        raise


@router.get("")
async def list_books():
    return {"books": library.list_books()}


@router.post("", status_code=201)
async def import_book(file: UploadFile = File(...)):
    staged = None
    try:
        try:
            staged = await _stage_upload(file)
        except ValueError:
            _error("UPLOAD_TOO_LARGE", "Book files may not exceed 2 GB.", 413)
        filename = file.filename or "book.pdf"
        try:
            if filename.lower().endswith(".bookvoice"):
                return library.import_bookvoice_path(staged, filename)
            return library.import_pdf_path(staged, filename)
        except (ValueError, FileNotFoundError, KeyError, RuntimeError) as exc:
            _error("INVALID_BOOK_FILE", str(exc))
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)


@router.get("/{book_id}")
async def get_book(book_id: str):
    try:
        return library.get_book(book_id)
    except (ValueError, FileNotFoundError) as exc:
        _error("BOOK_NOT_FOUND", str(exc), 404)


@router.delete("/{book_id}", status_code=204)
async def delete_book(book_id: str):
    try:
        library.delete_book(book_id)
    except RuntimeError as exc:
        _error("BOOK_BUSY", str(exc), 409)
    except ValueError as exc:
        _error("BOOK_NOT_FOUND", str(exc), 404)


@router.get("/{book_id}/source")
async def get_source(book_id: str):
    try:
        source = library.book_dir(book_id) / "source.pdf"
        if not source.is_file():
            raise FileNotFoundError("Book PDF was not found.")
        return FileResponse(source, media_type="application/pdf", filename=f"{book_id}.pdf")
    except (ValueError, FileNotFoundError) as exc:
        _error("BOOK_NOT_FOUND", str(exc), 404)


@router.put("/{book_id}/pages/{page}")
async def save_page(book_id: str, page: int, update: PageUpdate):
    try:
        return library.save_page(book_id, page, update.text, update.pageCount)
    except (ValueError, FileNotFoundError) as exc:
        _error("INVALID_PAGE", str(exc))


@router.patch("/{book_id}/progress")
async def update_progress(book_id: str, update: ProgressUpdate):
    try:
        return library.update_progress(book_id, update.model_dump(exclude_none=True))
    except (ValueError, FileNotFoundError) as exc:
        _error("BOOK_NOT_FOUND", str(exc), 404)


@router.get("/{book_id}/profiles/{profile_id}/pages/{page}")
async def get_prepared_page(book_id: str, profile_id: str, page: int):
    try:
        metadata = library.get_page(book_id, page)
        audio = library.prepared_audio_metadata(book_id, profile_id, page, metadata)
        if audio:
            metadata["audio"] = audio
            metadata["audioUrl"] = f"/api/books/{book_id}/profiles/{profile_id}/pages/{page}/audio"
        return metadata
    except (ValueError, FileNotFoundError) as exc:
        _error("PAGE_NOT_FOUND", str(exc), 404)


@router.get("/{book_id}/profiles/{profile_id}/pages/{page}/audio")
async def get_prepared_audio(book_id: str, profile_id: str, page: int):
    try:
        audio = library.page_audio_path(book_id, profile_id, page)
        if not library.has_valid_page_audio(book_id, profile_id, page):
            raise FileNotFoundError("Prepared page audio was not found.")
        return FileResponse(audio, media_type="audio/wav")
    except (ValueError, FileNotFoundError) as exc:
        _error("AUDIO_NOT_FOUND", str(exc), 404)


@router.post("/{book_id}/preparations", status_code=202)
async def create_preparation(book_id: str, request: PreparationCreate):
    try:
        return library.start_preparation(book_id, request.voiceId, request.languageId)
    except (ValueError, FileNotFoundError) as exc:
        _error("PREPARATION_REJECTED", str(exc), 409)


@router.post("/{book_id}/archives", status_code=201)
async def create_archive(book_id: str, request: ArchiveCreate):
    try:
        record = library.create_archive(book_id, request.profileId)
        return {
            "id": record["id"],
            "bookId": record["bookId"],
            "profileId": record["profileId"],
            "status": record["status"],
            "downloadUrl": f"/api/book-archives/{record['id']}/content",
        }
    except (ValueError, FileNotFoundError) as exc:
        _error("ARCHIVE_REJECTED", str(exc), 409)


preparations_router = APIRouter()


@preparations_router.get("/{job_id}")
async def get_preparation(job_id: str):
    try:
        return library.get_preparation(job_id)
    except FileNotFoundError as exc:
        _error("PREPARATION_NOT_FOUND", str(exc), 404)


@preparations_router.delete("/{job_id}")
async def cancel_preparation(job_id: str):
    try:
        return library.cancel_preparation(job_id)
    except FileNotFoundError as exc:
        _error("PREPARATION_NOT_FOUND", str(exc), 404)


archives_router = APIRouter()


@archives_router.get("/{archive_id}")
async def get_archive(archive_id: str):
    try:
        record = library.get_archive(archive_id)
        return {**{key: value for key, value in record.items() if key != "path"}, "downloadUrl": f"/api/book-archives/{archive_id}/content"}
    except FileNotFoundError as exc:
        _error("ARCHIVE_NOT_FOUND", str(exc), 404)


@archives_router.get("/{archive_id}/content")
async def download_archive(archive_id: str):
    try:
        record = library.get_archive(archive_id)
        path = Path(record["path"])
        if not path.is_file():
            raise FileNotFoundError("Prepared-book archive file is missing.")
        return FileResponse(path, media_type="application/zip", filename=path.name)
    except FileNotFoundError as exc:
        _error("ARCHIVE_NOT_FOUND", str(exc), 404)
