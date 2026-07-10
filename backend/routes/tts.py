import asyncio
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services.path_utils import (
    MAX_TEXT_CHARS,
    validate_language_id,
    validate_page_index,
    validate_session_id,
    validate_text_length,
)
from services.config_service import config_value
from services.alignment_service import alignment_mode
from services.tts_service import (
    GenerationCancelled,
    TtsPriority,
    bump_generation,
    export_cached_pages,
    narrate_text,
    narrate_text_streaming,
    pronounce_text,
    request_reload,
    state_snapshot,
    submit_tts,
)

router = APIRouter()


class NarrateRequest(BaseModel):
    text: str = Field(..., max_length=MAX_TEXT_CHARS + 500)
    session_id: str
    page_index: int
    voice_id: str | None = None
    language_id: str = "en"
    clip_suffix: str | None = None
    priority: str = "current"  # interactive | current | prefetch


class PronounceRequest(BaseModel):
    text: str = Field(..., max_length=500)
    session_id: str
    voice_id: str | None = None
    language_id: str = "en"


class ExportRequest(BaseModel):
    session_id: str
    start_page: int
    end_page: int


class ExportResponse(BaseModel):
    audio_url: str
    pages: list[int]
    duration_s: float


class WordTiming(BaseModel):
    word: str
    start_s: float
    end_s: float


class NarrateSegment(BaseModel):
    text: str
    start_s: float
    end_s: float


class NarrateResponse(BaseModel):
    audio_url: str
    segments: list[NarrateSegment] = []
    duration_s: float = 0.0
    word_timings: list[WordTiming] = []
    alignment_mode: str = "estimate"


def _priority_from_str(value: str) -> TtsPriority:
    key = (value or "current").strip().lower()
    if key == "interactive":
        return TtsPriority.INTERACTIVE
    if key == "prefetch":
        return TtsPriority.PREFETCH
    return TtsPriority.CURRENT


def _build_response(result: dict) -> NarrateResponse:
    word_timings = result.get("word_timings") or []
    return NarrateResponse(
        audio_url=result["audio_url"],
        segments=result.get("segments") or [],
        duration_s=float(result.get("duration_s") or 0.0),
        word_timings=[
            WordTiming(word=w["word"], start_s=w["start_s"], end_s=w["end_s"])
            for w in word_timings
            if isinstance(w, dict) and "word" in w
        ],
        alignment_mode=alignment_mode(),
    )


@router.get("/status")
async def tts_status():
    return state_snapshot()


@router.post("/reload")
async def tts_reload():
    """Retry loading the model after an error (e.g. VRAM was busy)."""
    language_id = str(config_value("language_id", "en") or "en")
    try:
        language_id = validate_language_id(language_id)
    except ValueError:
        language_id = "en"
    return request_reload(language_id)


@router.post("/pronounce", response_model=NarrateResponse)
async def pronounce(request: PronounceRequest):
    try:
        text = validate_text_length(request.text)
        session_id = validate_session_id(request.session_id)
        language_id = validate_language_id(request.language_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    loop = asyncio.get_running_loop()
    try:
        future = submit_tts(
            TtsPriority.INTERACTIVE,
            pronounce_text,
            text,
            session_id,
            request.voice_id,
            language_id,
        )
        result = await loop.run_in_executor(None, future.result)
        if isinstance(result, str):
            return NarrateResponse(audio_url=result)
        return _build_response(result)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/narrate", response_model=NarrateResponse)
async def narrate(request: NarrateRequest):
    try:
        text = validate_text_length(request.text)
        session_id = validate_session_id(request.session_id)
        page_index = validate_page_index(request.page_index)
        language_id = validate_language_id(request.language_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    priority = _priority_from_str(request.priority)
    loop = asyncio.get_running_loop()
    try:
        future = submit_tts(
            priority,
            narrate_text,
            text,
            session_id,
            page_index,
            request.voice_id,
            language_id,
            request.clip_suffix,
        )
        result = await loop.run_in_executor(None, future.result)
        if isinstance(result, str):
            return NarrateResponse(audio_url=result)
        return _build_response(result)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except GenerationCancelled as e:
        # 499 Client Closed Request (de facto "superseded by newer work").
        raise HTTPException(status_code=499, detail="superseded") from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/cancel-generation")
async def cancel_generation():
    """Invalidate in-flight TTS work (page change / voice switch / document close)."""
    token = bump_generation()
    return {"cancelled_token": token}


@router.post("/export", response_model=ExportResponse)
async def export_audio(request: ExportRequest):
    """Export already-generated, canonical full-page audio for an inclusive range."""
    try:
        session_id = validate_session_id(request.session_id)
        start_page = validate_page_index(request.start_page)
        end_page = validate_page_index(request.end_page)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    loop = asyncio.get_running_loop()
    try:
        future = submit_tts(TtsPriority.CURRENT, export_cached_pages, session_id, start_page, end_page)
        result = await loop.run_in_executor(None, future.result)
        return ExportResponse(**result)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/narrate-stream")
async def narrate_stream(request: NarrateRequest):
    """Stream per-chunk audio as NDJSON for first-audio-early playback.

    Each line is a JSON object: {"type": "chunk", ...} per synthesized chunk,
    then a final {"type": "done", ...} with the full-page URL, segments,
    duration, word_timings, and alignment_mode. The first chunk line returns
    as soon as chunk 0 is synthesized, before the rest of the page.
    """
    try:
        text = validate_text_length(request.text)
        session_id = validate_session_id(request.session_id)
        page_index = validate_page_index(request.page_index)
        language_id = validate_language_id(request.language_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    loop = asyncio.get_running_loop()

    async def event_stream():
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def run_sync():
            try:
                for event in narrate_text_streaming(
                    text, session_id, page_index, request.voice_id, language_id
                ):
                    asyncio.run_coroutine_threadsafe(queue.put(event), loop).result()
            except Exception as exc:  # noqa: BLE001 - surface to the client
                asyncio.run_coroutine_threadsafe(queue.put(exc), loop).result()

        loop.run_in_executor(None, run_sync)

        while True:
            item = await queue.get()
            if isinstance(item, GenerationCancelled):
                yield json.dumps({"type": "cancelled"}) + "\n"
                return
            if isinstance(item, Exception):
                yield json.dumps({"type": "error", "detail": str(item)}) + "\n"
                return
            line = dict(item)
            if item.get("type") == "done":
                line["alignment_mode"] = alignment_mode()
            yield json.dumps(line) + "\n"
            if item.get("type") == "done":
                return

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")
