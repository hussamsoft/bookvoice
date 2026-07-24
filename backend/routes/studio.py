"""Voice Studio projects, media assets, profiles, narration, and repair jobs."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from services import studio_service as studio


router = APIRouter()
UPLOAD_CHUNK_BYTES = 1024 * 1024


class ProjectCreate(BaseModel):
    name: str = Field("Untitled project", min_length=1, max_length=100)


class GenerationSettingsInput(BaseModel):
    pace: float = Field(1.0, ge=0.75, le=1.25)
    expression: float = Field(0.5, ge=0, le=1)
    temperature: float = Field(0.8, ge=0.1, le=1.5)
    guidance: float | None = Field(None, ge=0, le=1)
    seed: int | None = Field(None, ge=0, le=4_294_967_295)


class ProjectPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    script: str | None = Field(None, max_length=studio.SCRIPT_MAX_CHARS)
    languageId: str | None = None
    voiceId: str | None = None
    generationSettings: GenerationSettingsInput | None = None
    activeWorkflow: str | None = None


class ProfileCreate(BaseModel):
    sourceId: str
    name: str = Field(..., min_length=1, max_length=64)
    startSec: float = Field(..., ge=0)
    endSec: float = Field(..., gt=0)
    consentConfirmed: bool = False


class NarrationCreate(BaseModel):
    text: str = Field(..., min_length=1, max_length=studio.SCRIPT_MAX_CHARS)
    languageId: str = "en"
    voiceId: str | None = None
    generationSettings: GenerationSettingsInput = Field(default_factory=GenerationSettingsInput)


class RepairCreate(BaseModel):
    assetId: str
    startSec: float = Field(..., ge=0)
    endSec: float = Field(..., gt=0)
    replacementText: str = Field(..., min_length=1, max_length=2_000)
    languageId: str = "en"
    voiceId: str | None = None
    generationSettings: GenerationSettingsInput = Field(default_factory=GenerationSettingsInput)


def _error(code: str, message: str, status: int = 400):
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


@router.get("/projects")
async def list_projects():
    return {"projects": studio.list_projects()}


@router.post("/projects", status_code=201)
async def create_project(request: ProjectCreate):
    try:
        return studio.create_project(request.name)
    except ValueError as exc:
        _error("INVALID_PROJECT", str(exc))


@router.get("/projects/{project_id}")
async def get_project(project_id: str):
    try:
        return studio.get_project(project_id)
    except ValueError as exc:
        _error("INVALID_PROJECT_ID", str(exc))
    except FileNotFoundError as exc:
        _error("PROJECT_NOT_FOUND", str(exc), 404)
    except RuntimeError as exc:
        _error("PROJECT_UNAVAILABLE", str(exc), 409)


@router.patch("/projects/{project_id}")
async def update_project(project_id: str, request: ProjectPatch):
    changes = request.model_dump(exclude_unset=True)
    if "generationSettings" in changes and request.generationSettings is not None:
        changes["generationSettings"] = request.generationSettings.model_dump()
    try:
        return studio.update_project(project_id, changes)
    except ValueError as exc:
        _error("INVALID_PROJECT", str(exc))
    except FileNotFoundError as exc:
        _error("PROJECT_NOT_FOUND", str(exc), 404)


@router.post("/projects/{project_id}/copies", status_code=201)
async def duplicate_project(project_id: str):
    try:
        return studio.duplicate_project(project_id)
    except ValueError as exc:
        _error("INVALID_PROJECT_ID", str(exc))
    except FileNotFoundError as exc:
        _error("PROJECT_NOT_FOUND", str(exc), 404)


@router.delete("/projects/{project_id}", status_code=204)
async def delete_project(project_id: str):
    try:
        studio.delete_project(project_id)
    except ValueError as exc:
        _error("INVALID_PROJECT_ID", str(exc))
    except FileNotFoundError as exc:
        _error("PROJECT_NOT_FOUND", str(exc), 404)


@router.post("/projects/{project_id}/open-folder")
async def open_project_folder(project_id: str):
    try:
        return studio.open_project_folder(project_id)
    except ValueError as exc:
        _error("INVALID_PROJECT_ID", str(exc))
    except FileNotFoundError as exc:
        _error("PROJECT_NOT_FOUND", str(exc), 404)
    except OSError as exc:
        _error("OPEN_FOLDER_UNAVAILABLE", str(exc), 501)


async def _stage_upload(file: UploadFile) -> Path:
    staging = studio.studio_root() / "staging"
    fd, name = tempfile.mkstemp(prefix="studio-upload-", suffix=".tmp", dir=staging)
    target = Path(name)
    total = 0
    try:
        with os.fdopen(fd, "wb") as destination:
            while True:
                chunk = await file.read(UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > studio.MAX_SOURCE_BYTES:
                    raise ValueError("Studio media may not exceed 2 GB.")
                destination.write(chunk)
            destination.flush()
            os.fsync(destination.fileno())
        if total == 0:
            raise ValueError("Uploaded media is empty.")
        return target
    except Exception:
        target.unlink(missing_ok=True)
        raise


@router.post("/projects/{project_id}/sources", status_code=202)
async def import_source(project_id: str, file: UploadFile = File(...)):
    try:
        studio.get_project(project_id)
        staged = await _stage_upload(file)
    except ValueError as exc:
        _error("INVALID_MEDIA", str(exc), 413 if "2 GB" in str(exc) else 400)
    except FileNotFoundError as exc:
        _error("PROJECT_NOT_FOUND", str(exc), 404)

    filename = file.filename or "media.wav"

    def work(*, job_id, cancel_event):
        try:
            studio.update_job_progress(project_id, job_id, 0.15, "Inspecting media")
            if cancel_event.is_set():
                return None
            source = studio.import_source_path(project_id, staged, filename)
            studio.update_job_progress(project_id, job_id, 0.9, "Building waveform")
            return {"sourceId": source["id"]}
        finally:
            staged.unlink(missing_ok=True)

    return studio.submit_job(project_id, "MEDIA_IMPORT", work)


@router.post("/projects/{project_id}/profiles", status_code=202)
async def create_profile(project_id: str, request: ProfileCreate):
    try:
        studio.get_project(project_id)
    except ValueError as exc:
        _error("INVALID_PROJECT_ID", str(exc))
    except FileNotFoundError as exc:
        _error("PROJECT_NOT_FOUND", str(exc), 404)
    if not request.consentConfirmed:
        _error(
            "VOICE_CONSENT_REQUIRED",
            "Confirm that you own or have permission to clone this voice.",
        )

    def work(*, job_id, cancel_event):
        studio.update_job_progress(project_id, job_id, 0.2, "Extracting voice sample")
        if cancel_event.is_set():
            return None
        profile = studio.create_voice_profile(
            project_id,
            request.sourceId,
            request.name,
            request.startSec,
            request.endSec,
            consent_confirmed=True,
        )
        return {"voiceId": profile["id"]}

    return studio.submit_job(project_id, "VOICE_PROFILE", work)


@router.post("/projects/{project_id}/narrations", status_code=202)
async def create_narration(project_id: str, request: NarrationCreate):
    try:
        studio.get_project(project_id)
        settings = studio.validate_generation_settings(request.generationSettings.model_dump())
    except ValueError as exc:
        _error("INVALID_NARRATION", str(exc))
    except FileNotFoundError as exc:
        _error("PROJECT_NOT_FOUND", str(exc), 404)

    def work(*, job_id, cancel_event):
        studio.update_job_progress(project_id, job_id, 0.1, "Preparing narration")
        output = studio.create_narration(
            project_id,
            request.text,
            request.languageId,
            request.voiceId,
            settings,
            cancel_event=cancel_event,
        )
        return {"outputId": output["id"]}

    return studio.submit_job(project_id, "NARRATION", work)


@router.post("/projects/{project_id}/repairs", status_code=202)
async def create_repair(project_id: str, request: RepairCreate):
    try:
        studio.get_project(project_id)
        settings = studio.validate_generation_settings(request.generationSettings.model_dump())
    except ValueError as exc:
        _error("INVALID_REPAIR", str(exc))
    except FileNotFoundError as exc:
        _error("PROJECT_NOT_FOUND", str(exc), 404)

    def work(*, job_id, cancel_event):
        studio.update_job_progress(project_id, job_id, 0.1, "Generating replacement")
        result = studio.create_repair(
            project_id,
            request.assetId,
            request.startSec,
            request.endSec,
            request.replacementText,
            request.languageId,
            request.voiceId,
            settings,
            cancel_event=cancel_event,
        )
        return {
            "repairId": result["repair"]["id"],
            "outputId": result["output"]["id"],
        }

    return studio.submit_job(project_id, "MEDIA_REPAIR", work)


@router.post("/projects/{project_id}/repairs/{repair_id}/exports", status_code=202)
async def export_repair(project_id: str, repair_id: str):
    try:
        studio.get_project(project_id)
    except ValueError as exc:
        _error("INVALID_PROJECT_ID", str(exc))
    except FileNotFoundError as exc:
        _error("PROJECT_NOT_FOUND", str(exc), 404)

    def work(*, job_id, cancel_event):
        studio.update_job_progress(project_id, job_id, 0.1, "Exporting repaired video")
        if cancel_event.is_set():
            return None
        output = studio.export_repair_video(project_id, repair_id)
        return {"outputId": output["id"]}

    return studio.submit_job(project_id, "VIDEO_EXPORT", work)


@router.post("/projects/{project_id}/outputs/{output_id}/download", status_code=202)
async def download_output(project_id: str, output_id: str):
    try:
        studio.get_project(project_id)
    except ValueError as exc:
        _error("INVALID_PROJECT_ID", str(exc))
    except FileNotFoundError as exc:
        _error("PROJECT_NOT_FOUND", str(exc), 404)

    def work(*, job_id, cancel_event):
        studio.update_job_progress(project_id, job_id, 0.05, "Saving to Downloads")
        return studio.save_output_to_downloads(
            project_id,
            output_id,
            cancel_event=cancel_event,
            progress=lambda value: studio.update_job_progress(
                project_id, job_id, value, "Saving to Downloads"
            ),
        )

    return studio.submit_job(project_id, "SAVE_OUTPUT", work)


@router.get("/projects/{project_id}/assets/{asset_id}/{variant}")
async def get_asset(project_id: str, asset_id: str, variant: str):
    if variant not in {"content", "original", "audio", "preview"}:
        _error("ASSET_NOT_FOUND", "Studio asset was not found.", 404)
    try:
        path = studio.asset_path(project_id, asset_id, variant)
    except (ValueError, FileNotFoundError) as exc:
        _error("ASSET_NOT_FOUND", str(exc), 404)
    media_type = {
        ".wav": "audio/wav",
        ".mp4": "video/mp4",
    }.get(path.suffix.lower())
    return FileResponse(
        path,
        media_type=media_type,
        filename=path.name,
        content_disposition_type="inline" if variant == "preview" else "attachment",
    )


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    try:
        return studio.get_job(job_id)
    except (ValueError, FileNotFoundError) as exc:
        _error("JOB_NOT_FOUND", str(exc), 404)


@router.delete("/jobs/{job_id}")
async def cancel_job(job_id: str):
    try:
        return studio.cancel_job(job_id)
    except (ValueError, FileNotFoundError) as exc:
        _error("JOB_NOT_FOUND", str(exc), 404)
