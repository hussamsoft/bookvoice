import asyncio
import atexit
import logging
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.path_utils import MAX_TEXT_CHARS, validate_language_id
from services.translation_service import translate_text

router = APIRouter()
_executor = ThreadPoolExecutor(max_workers=1)
# Audit finding C-7: atexit.register the executor so background
# threads don't leak on process exit. Mirror the Studio pattern
# (services/studio_service/manifest.py:_shutdown_executor).
atexit.register(lambda: _executor.shutdown(wait=False))
_log = logging.getLogger(__name__)


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
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        _log.exception("Translation failed")
        raise HTTPException(status_code=500, detail="Translation failed.") from e
