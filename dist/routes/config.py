from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.config_service import app_version, get_config, update_config
from services.path_utils import validate_language_id, validate_voice_id

router = APIRouter()


class ConfigUpdate(BaseModel):
    voice_id: str | None = None
    language_id: str | None = None
    ocr_use_gpu: bool | None = None
    tts_device: str | None = None


@router.get("/")
async def read_config():
    return {"version": app_version(), "config": get_config()}


@router.put("/")
async def write_config(update: ConfigUpdate):
    partial = update.model_dump(exclude_unset=True)
    try:
        if "language_id" in partial and partial["language_id"] is not None:
            partial["language_id"] = validate_language_id(partial["language_id"])
        if "voice_id" in partial:
            # Empty string / null both mean "default voice".
            if partial["voice_id"]:
                partial["voice_id"] = validate_voice_id(partial["voice_id"])
            else:
                partial["voice_id"] = None
        if "tts_device" in partial and partial["tts_device"] not in (
            None,
            "auto",
            "cpu",
            "cuda",
            "mps",
        ):
            raise ValueError("tts_device must be one of: auto, cpu, cuda, mps.")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        config = update_config(partial)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not save config: {e}") from e
    return {"version": app_version(), "config": config}
