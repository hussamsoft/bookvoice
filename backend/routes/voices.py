import os
import shutil
import struct
import wave
from io import BytesIO

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from services.path_utils import MAX_VOICE_BYTES, validate_voice_id

router = APIRouter()

_data_dir = os.environ.get("DATA_DIR", "data")
VOICES_DIR = os.path.join(_data_dir, "voices")
DEFAULT_VOICES_DIR = os.environ.get(
    "DEFAULT_VOICES_DIR", os.path.join("data", "default_voices")
)
os.makedirs(VOICES_DIR, exist_ok=True)

_ALLOWED_CONTENT_TYPES = {
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "application/octet-stream",
    "audio/webm",
    "audio/ogg",
    "video/webm",
}


def seed_default_voices():
    if os.path.exists(DEFAULT_VOICES_DIR):
        for f in os.listdir(DEFAULT_VOICES_DIR):
            if f.endswith(".wav"):
                src = os.path.join(DEFAULT_VOICES_DIR, f)
                dst = os.path.join(VOICES_DIR, f)
                if not os.path.exists(dst):
                    shutil.copy2(src, dst)


def _looks_like_wav(data: bytes) -> bool:
    if len(data) < 12:
        return False
    return data[0:4] == b"RIFF" and data[8:12] == b"WAVE"


def _convert_to_wav_pcm(data: bytes) -> bytes:
    """
    Accept real WAV, or convert other formats via librosa when available.
    Returns PCM WAV bytes.
    """
    if _looks_like_wav(data):
        # Re-save via wave module to normalize; if that fails, try librosa.
        try:
            with wave.open(BytesIO(data), "rb") as wf:
                params = wf.getparams()
                frames = wf.readframes(params.nframes)
            out = BytesIO()
            with wave.open(out, "wb") as wf:
                wf.setparams(params)
                wf.writeframes(frames)
            return out.getvalue()
        except wave.Error:
            pass

    try:
        import librosa
        import numpy as np
        import soundfile as sf
    except ImportError as e:
        raise ValueError(
            "Only standard PCM .wav files are supported without audio converters. "
            "Install soundfile/librosa or upload a WAV recording."
        ) from e

    try:
        # librosa can decode webm/ogg if audioread/ffmpeg is present; otherwise WAV only.
        y, sr = librosa.load(BytesIO(data), sr=22050, mono=True)
        out = BytesIO()
        sf.write(out, y, sr, format="WAV", subtype="PCM_16")
        return out.getvalue()
    except Exception as e:
        raise ValueError(
            f"Could not decode audio as WAV. Record again or upload a .wav file. ({e})"
        ) from e


def _validate_wav_duration(data: bytes, min_sec: float = 0.3, max_sec: float = 60.0):
    try:
        with wave.open(BytesIO(data), "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate() or 1
            duration = frames / float(rate)
    except wave.Error as e:
        raise ValueError(f"Invalid WAV file: {e}") from e

    if duration < min_sec:
        raise ValueError(f"Voice sample too short ({duration:.1f}s). Need at least {min_sec}s.")
    if duration > max_sec:
        raise ValueError(f"Voice sample too long ({duration:.1f}s). Maximum is {max_sec}s.")


@router.get("/")
async def list_voices():
    seed_default_voices()
    voices = []
    if os.path.exists(VOICES_DIR):
        for f in sorted(os.listdir(VOICES_DIR)):
            if f.endswith(".wav"):
                voices.append(
                    {"id": f[:-4], "name": f[:-4].replace("_", " ").title()}
                )
    return {"voices": voices}


@router.post("/")
async def upload_voice(
    file: UploadFile = File(...),
    name: str = Form(...),
):
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(raw) > MAX_VOICE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum is {MAX_VOICE_BYTES // (1024 * 1024)} MB.",
        )

    content_type = (file.content_type or "").split(";")[0].strip().lower()
    filename = (file.filename or "").lower()
    if content_type and content_type not in _ALLOWED_CONTENT_TYPES:
        # Still allow if extension/magic looks ok.
        if not (filename.endswith(".wav") or _looks_like_wav(raw)):
            raise HTTPException(
                status_code=400,
                detail="Unsupported audio type. Upload a .wav file or use in-app recording.",
            )

    safe_name = "".join(c for c in name if c.isalnum() or c in (" ", "-", "_")).strip()
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid voice name.")

    try:
        voice_id = validate_voice_id(safe_name.replace(" ", "_").lower())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        wav_bytes = _convert_to_wav_pcm(raw)
        _validate_wav_duration(wav_bytes)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    file_path = os.path.join(VOICES_DIR, f"{voice_id}.wav")
    try:
        with open(file_path, "wb") as buffer:
            buffer.write(wav_bytes)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {e}") from e

    return {"id": voice_id, "name": safe_name, "message": "Voice profile created."}
