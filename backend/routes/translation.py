import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.path_utils import MAX_TEXT_CHARS, validate_language_id
from services.translation_service import translate_text

router = APIRouter()
_executor = ThreadPoolExecutor(max_workers=1)


class TranslationRequest(BaseModel):
    text: str = Field(..., max_length=MAX_TEXT_CHARS + 500)
    target_lang: str


class TranslationResponse(BaseModel):
    translated_text: str


@router.post("/", response_model=TranslationResponse)
async def translate(request: TranslationRequest):
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    try:
        target = validate_language_id(request.target_lang)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    loop = asyncio.get_running_loop()
    try:
        translated = await loop.run_in_executor(
            _executor, translate_text, request.text, target
        )
        return TranslationResponse(translated_text=translated)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
