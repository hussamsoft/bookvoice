import os
import shutil
import tempfile
import wave
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from services.path_utils import MAX_VOICE_BYTES, validate_voice_id
from services import voice_profile_service

router = APIRouter()

_ALLOWED_CONTENT_TYPES = {
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "application/octet-stream",
    "audio/webm",
    "audio/ogg",
    "video/webm",
}


def _voices_dir() -> str:
    """Resolve at call time so launcher env vars are always honored."""
    data_dir = os.environ.get("DATA_DIR", "data")
    path = os.path.join(data_dir, "voices")
    os.makedirs(path, exist_ok=True)
    return path


def _default_voices_dir() -> str:
    env = os.environ.get("DEFAULT_VOICES_DIR", "").strip()
    if env:
        return env
    app_dir = os.environ.get("APP_DIR", "").strip()
    if app_dir:
        return os.path.join(app_dir, "data", "default_voices")
    return os.path.join("data", "default_voices")


def seed_default_voices():
    src = _default_voices_dir()
    dst = _voices_dir()
    if not os.path.isdir(src):
        return
    for f in os.listdir(src):
        if f.endswith(".wav"):
            s = os.path.join(src, f)
            d = os.path.join(dst, f)
            if not os.path.exists(d):
                try:
                    fd, temp_name = tempfile.mkstemp(prefix=f".{f}-", suffix=".tmp", dir=dst)
                    os.close(fd)
                    shutil.copy2(s, temp_name)
                    os.replace(temp_name, d)
                except OSError:
                    try:
                        os.unlink(temp_name)
                    except (OSError, UnboundLocalError):
                        pass
                    pass


def _looks_like_wav(data: bytes) -> bool:
    return len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WAVE"


def _convert_to_wav_pcm(data: bytes) -> bytes:
    if _looks_like_wav(data):
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
        import soundfile as sf
    except ImportError as e:
        raise ValueError(
            "Only standard PCM .wav files are supported without audio converters."
        ) from e

    try:
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
    return {"voices": voice_profile_service.list_profiles()}


@router.post("/")
async def upload_voice(
    file: UploadFile = File(...),
    name: str = Form(...),
    consent_confirmed: bool = Form(False),
):
    if not consent_confirmed:
        raise HTTPException(
            status_code=400,
            detail="Confirm that you own or have permission to clone this voice.",
        )
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

    temp_path = None
    try:
        fd, temp_path = tempfile.mkstemp(prefix=f".{voice_id}-", suffix=".wav", dir=_voices_dir())
        with os.fdopen(fd, "wb") as buffer:
            buffer.write(wav_bytes)
            buffer.flush()
            os.fsync(buffer.fileno())
        profile = voice_profile_service.create_profile(
            Path(temp_path),
            safe_name,
            consent_confirmed=True,
            source_info={"kind": "AUDIO", "fileName": file.filename},
            min_seconds=0.3,
            max_seconds=60,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {e}") from e
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass

    return {**profile, "message": "Voice profile created."}


@router.delete("/{voice_id}")
async def delete_voice(voice_id: str):
    try:
        safe_id = validate_voice_id(voice_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        voice_profile_service.delete_profile(safe_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail="Voice not found.") from e
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete voice: {e}") from e

    return {"id": safe_id, "message": "Voice deleted."}
