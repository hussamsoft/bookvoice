import json
import mimetypes
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

from routes import ocr, translation, tts, voices
from services.path_utils import safe_join
from services.tts_service import maybe_cleanup_sessions

mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/javascript", ".js")

# Force CUDA context initialization on the main thread to prevent background thread deadlocks
try:
    import torch

    if torch.cuda.is_available():
        torch.cuda.init()
        print("CUDA context initialized on the main thread.")
except Exception as e:
    print(f"Failed to initialize CUDA context on the main thread: {e}")

DATA_DIR = os.environ.get("DATA_DIR", "data")
DEFAULT_VOICES_DIR = os.environ.get(
    "DEFAULT_VOICES_DIR", os.path.join("data", "default_voices")
)
MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join("data", "models"))
APP_DIR = os.environ.get("APP_DIR", os.getcwd())
os.makedirs(DATA_DIR, exist_ok=True)
print(f"[main] DATA_DIR={DATA_DIR}")
print(f"[main] MODEL_DIR={MODEL_DIR}")
print(f"[main] APP_DIR={APP_DIR}")

SESSIONS_DIR = os.path.join(DATA_DIR, "sessions")
VOICES_DIR = os.path.join(DATA_DIR, "voices")
os.makedirs(SESSIONS_DIR, exist_ok=True)
os.makedirs(VOICES_DIR, exist_ok=True)

_preload_attempted = False
_preload_error = None


def _try_preload_model():
    global _preload_attempted, _preload_error
    _preload_attempted = True
    try:
        maybe_cleanup_sessions(force=True)
        from services.tts_service import get_model

        get_model("en")
        print("TTS model preloaded successfully.")
    except Exception as e:
        _preload_error = str(e)
        print(f"TTS model preload failed (will retry on first request): {e}")
        try:
            from services.tts_service import _model_state

            _model_state["status"] = "error"
            _model_state["detail"] = f"Preload failed: {e}"
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    threading.Thread(target=_try_preload_model, daemon=True).start()
    yield


app = FastAPI(title="BookVoice API", lifespan=lifespan)

cors_origins_str = os.getenv("CORS_ORIGINS", '["*"]')
try:
    origins = json.loads(cors_origins_str)
except Exception:
    origins = ["*"]

allow_credentials = origins != ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tts.router, prefix="/api/tts", tags=["tts"])
app.include_router(voices.router, prefix="/api/voices", tags=["voices"])
app.include_router(translation.router, prefix="/api/translate", tags=["translation"])
app.include_router(ocr.router, prefix="/api/ocr", tags=["ocr"])

app.mount("/sessions", StaticFiles(directory=SESSIONS_DIR), name="sessions")

STATIC_DIR = Path("static").resolve()


if STATIC_DIR.is_dir():
    if (STATIC_DIR / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("sessions/"):
            raise HTTPException(status_code=404, detail="Not found")

        # Prevent path traversal: only serve files under static/
        try:
            if full_path and full_path not in (".",):
                candidate = safe_join(str(STATIC_DIR), full_path)
                if os.path.isfile(candidate):
                    return FileResponse(candidate)
        except ValueError:
            raise HTTPException(status_code=404, detail="Not found") from None

        index = STATIC_DIR / "index.html"
        if index.is_file():
            return FileResponse(str(index))
        raise HTTPException(status_code=404, detail="Frontend not found")
else:

    @app.get("/")
    async def root():
        return {"message": "BookVoice API is running (Frontend not built)"}
