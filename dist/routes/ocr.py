import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.ocr_service import extract_text_from_image

router = APIRouter()
_executor = ThreadPoolExecutor(max_workers=1)


class OCRRequest(BaseModel):
    image_data: str


@router.post("")
async def process_ocr(req: OCRRequest):
    loop = asyncio.get_event_loop()
    try:
        text = await loop.run_in_executor(
            _executor, extract_text_from_image, req.image_data
        )
        return {"text": text}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR failed: {str(e)}")
