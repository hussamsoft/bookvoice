from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from services.tts_service import narrate_text

router = APIRouter()

class NarrateRequest(BaseModel):
    text: str
    session_id: str
    page_index: int
    
class NarrateResponse(BaseModel):
    audio_url: str

@router.post("/narrate", response_model=NarrateResponse)
async def narrate(request: NarrateRequest):
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")
        
    try:
        audio_url = narrate_text(
            text=request.text, 
            session_id=request.session_id, 
            page_index=request.page_index
        )
        return NarrateResponse(audio_url=audio_url)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
