from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
import json
from dotenv import load_dotenv
from fastapi.responses import FileResponse

load_dotenv()

from routes import tts

app = FastAPI(title="BookVoice API")

# Setup CORS for frontend development
cors_origins_str = os.getenv("CORS_ORIGINS", '["*"]')
try:
    origins = json.loads(cors_origins_str)
except Exception:
    origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(tts.router, prefix="/api/tts", tags=["tts"])

# Mount static files for generated audio sessions
os.makedirs("data/sessions", exist_ok=True)
app.mount("/sessions", StaticFiles(directory="data/sessions"), name="sessions")

# Serve frontend static files
if os.path.isdir("static"):
    # Mount assets directory directly
    if os.path.isdir("static/assets"):
        app.mount("/assets", StaticFiles(directory="static/assets"), name="assets")
        
    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("sessions/"):
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="Not found")
            
        path = os.path.join("static", full_path)
        if os.path.isfile(path):
            return FileResponse(path)
        return FileResponse("static/index.html")
else:
    @app.get("/")
    async def root():
        return {"message": "BookVoice API is running (Frontend not built)"}
