from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from google import genai
from google.genai import types
import os
import base64
from io import BytesIO
from PIL import Image

router = APIRouter()

class OCRRequest(BaseModel):
    image_data: str

@router.post("/")
async def process_ocr(req: OCRRequest):
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY is not set in the environment.")
    
    # Extract the base64 string
    # Format usually: "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
    try:
        header, encoded = req.image_data.split(",", 1)
    except ValueError:
        encoded = req.image_data
    
    try:
        image_bytes = base64.b64decode(encoded)
        image = Image.open(BytesIO(image_bytes))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image format: {str(e)}")

    try:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model='gemini-1.5-flash',
            contents=[
                image,
                "You are an OCR engine. Extract all the text from this image exactly as written. Do not add markdown formatting, do not summarize, just output the raw text. Ensure new lines are maintained."
            ]
        )
        return {"text": response.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini API Error: {str(e)}")
