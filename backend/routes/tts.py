import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.path_utils import (
    MAX_TEXT_CHARS,
    validate_language_id,
    validate_page_index,
    validate_session_id,
    validate_text_length,
)
from services.config_service import config_value
from services.tts_service import (
    TTS_EXECUTOR,
    narrate_text,
    request_reload,
    state_snapshot,
)

router = APIRouter()


class NarrateRequest(BaseModel):
    text: str = Field(..., max_length=MAX_TEXT_CHARS + 500)
    session_id: str
    page_index: int
    voice_id: str | None = None
    language_id: str = "en"


class NarrateResponse(BaseModel):
    audio_url: str


@router.get("/status")
async def tts_status():
    return state_snapshot()


@router.post("/reload")
async def tts_reload():
    """Retry loading the model after an error (e.g. VRAM was busy)."""
    language_id = str(config_value("language_id", "en") or "en")
    try:
        language_id = validate_language_id(language_id)
    except ValueError:
        language_id = "en"
    return request_reload(language_id)


@router.post("/narrate", response_model=NarrateResponse)
async def narrate(request: NarrateRequest):
    try:
        text = validate_text_length(request.text)
        session_id = validate_session_id(request.session_id)
        page_index = validate_page_index(request.page_index)
        language_id = validate_language_id(request.language_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    loop = asyncio.get_running_loop()
    try:
        audio_url = await loop.run_in_executor(
            TTS_EXECUTOR,
            narrate_text,
            text,
            session_id,
            page_index,
            request.voice_id,
            language_id,
        )
        return NarrateResponse(audio_url=audio_url)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
