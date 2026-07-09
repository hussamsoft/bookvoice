import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.ocr_service import extract_text_from_image

router = APIRouter()
_executor = ThreadPoolExecutor(max_workers=1)

# Base64 of a ~12MB image is larger; cap the JSON field reasonably.
_MAX_IMAGE_DATA_CHARS = 20 * 1024 * 1024


class OCRRequest(BaseModel):
    image_data: str = Field(..., max_length=_MAX_IMAGE_DATA_CHARS)


@router.post("")
async def process_ocr(req: OCRRequest):
    if not req.image_data or not req.image_data.strip():
        raise HTTPException(status_code=400, detail="image_data is required")

    loop = asyncio.get_running_loop()
    try:
        text = await loop.run_in_executor(
            _executor, extract_text_from_image, req.image_data
        )
        return {"text": text}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR failed: {e}") from e
