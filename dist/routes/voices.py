from fastapi import APIRouter, HTTPException, UploadFile, File, Form
import os
import shutil

router = APIRouter()
VOICES_DIR = os.path.join("data", "voices")
os.makedirs(VOICES_DIR, exist_ok=True)

@router.get("/")
async def list_voices():
    voices = []
    if os.path.exists(VOICES_DIR):
        for f in os.listdir(VOICES_DIR):
            if f.endswith(".wav"):
                voices.append({"id": f[:-4], "name": f[:-4]})
    return {"voices": voices}

@router.post("/")
async def upload_voice(
    file: UploadFile = File(...),
    name: str = Form(...)
):
    if not file.filename.endswith(".wav"):
        raise HTTPException(status_code=400, detail="Only .wav files are supported for voice profiles.")
    
    # Sanitize name
    safe_name = "".join([c for c in name if c.isalnum() or c in (' ', '-', '_')]).strip()
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid voice name.")
        
    voice_id = safe_name.replace(" ", "_").lower()
    
    file_path = os.path.join(VOICES_DIR, f"{voice_id}.wav")
    
    try:
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")
        
    return {"id": voice_id, "name": safe_name, "message": "Voice profile created."}
