from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import update_service

router = APIRouter()


class InstallRequest(BaseModel):
    version: str


@router.get("/")
async def read_updates():
    """Cached update state. Safe to poll; never fails on a network problem."""
    return update_service.check()


@router.post("/check")
async def force_check():
    return update_service.check(force=True)


@router.post("/download", status_code=202)
async def download_update(request: InstallRequest):
    if not update_service.supported():
        raise HTTPException(
            status_code=400,
            detail="Updates install from the Windows desktop app only.",
        )
    if not update_service.enabled():
        raise HTTPException(status_code=400, detail="Update checks are turned off.")
    if not update_service.is_newer(request.version, update_service.app_version()):
        raise HTTPException(
            status_code=400,
            detail=f"{request.version} is not newer than the installed version.",
        )
    return update_service.start_download(request.version)


@router.post("/install", status_code=202)
async def install_update(request: InstallRequest):
    """Hand off to the staged installer. The app exits moments after this returns."""
    try:
        return update_service.begin_install(request.version)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
