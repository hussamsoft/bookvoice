import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.path_utils import (
    MAX_TEXT_CHARS,
    validate_language_id,
    validate_page_index,
    validate_session_id,
    validate_text_length,
)
from services.tts_service import narrate_text, _model_state

router = APIRouter()
_executor = ThreadPoolExecutor(max_workers=1)


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
    return _model_state


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
            _executor,
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
