import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.tts_service import narrate_text

router = APIRouter()
_executor = ThreadPoolExecutor(max_workers=1)


class NarrateRequest(BaseModel):
    text: str
    session_id: str
    page_index: int
    voice_id: str | None = None
    language_id: str = "en"


class NarrateResponse(BaseModel):
    audio_url: str


@router.post("/narrate", response_model=NarrateResponse)
async def narrate(request: NarrateRequest):
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    loop = asyncio.get_event_loop()
    try:
        audio_url = await loop.run_in_executor(
            _executor,
            narrate_text,
            request.text,
            request.session_id,
            request.page_index,
            request.voice_id,
            request.language_id,
        )
        return NarrateResponse(audio_url=audio_url)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
