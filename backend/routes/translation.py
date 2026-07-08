import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.translation_service import translate_text

router = APIRouter()
_executor = ThreadPoolExecutor(max_workers=1)


class TranslationRequest(BaseModel):
    text: str
    target_lang: str


class TranslationResponse(BaseModel):
    translated_text: str


@router.post("/", response_model=TranslationResponse)
async def translate(request: TranslationRequest):
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    if not request.target_lang.strip():
        raise HTTPException(status_code=400, detail="Target language cannot be empty")

    loop = asyncio.get_event_loop()
    try:
        translated = await loop.run_in_executor(
            _executor, translate_text, request.text, request.target_lang
        )
        return TranslationResponse(translated_text=translated)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
