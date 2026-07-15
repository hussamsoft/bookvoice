import asyncio
import json
import threading

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services.path_utils import (
    MAX_NARRATION_TEXT_CHARS,
    validate_language_id,
    validate_page_index,
    validate_session_id,
    validate_narration_text_length,
)
from services.config_service import config_value
from services.alignment_service import alignment_mode
from services import book_library_service
from services.tts_service import (
    GenerationCancelled,
    GenerationCancellation,
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
_request_cancellations: dict[str, GenerationCancellation] = {}
_request_cancellations_lock = threading.Lock()


class NarrateRequest(BaseModel):
    text: str = Field(..., max_length=MAX_NARRATION_TEXT_CHARS)
    session_id: str
    page_index: int
    voice_id: str | None = None
    language_id: str = "en"
    clip_suffix: str | None = None
    priority: str = "current"  # interactive | current | prefetch
    book_id: str | None = None
    request_id: str | None = Field(None, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")


class CancelRequest(BaseModel):
    request_id: str | None = Field(None, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")


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


def _cache_completed_page(request: NarrateRequest, text: str, page_index: int, result: dict) -> None:
    if not request.book_id or request.clip_suffix is not None:
        return
    book_library_service.cache_generated_page(
        request.book_id,
        page_index,
        text,
        result["audio_url"],
        result.get("word_timings") or [],
        result.get("duration_s") or 0,
        request.voice_id,
        request.language_id,
    )


def _register_cancellation(request_id: str | None) -> GenerationCancellation:
    token = GenerationCancellation()
    if request_id:
        with _request_cancellations_lock:
            previous = _request_cancellations.get(request_id)
            if previous:
                previous.cancel()
            _request_cancellations[request_id] = token
    return token


def _release_cancellation(request_id: str | None, token: GenerationCancellation) -> None:
    if request_id:
        with _request_cancellations_lock:
            if _request_cancellations.get(request_id) is token:
                _request_cancellations.pop(request_id, None)


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
        text = validate_narration_text_length(request.text)
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
        text = validate_narration_text_length(request.text)
        session_id = validate_session_id(request.session_id)
        page_index = validate_page_index(request.page_index)
        language_id = validate_language_id(request.language_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    priority = _priority_from_str(request.priority)
    loop = asyncio.get_running_loop()
    cancellation = _register_cancellation(request.request_id)
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
            cancellation,
        )
        result = await loop.run_in_executor(None, future.result)
        if isinstance(result, str):
            return NarrateResponse(audio_url=result)
        _cache_completed_page(request, text, page_index, result)
        return _build_response(result)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except GenerationCancelled as e:
        # 499 Client Closed Request (de facto "superseded by newer work").
        raise HTTPException(status_code=499, detail="superseded") from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    finally:
        _release_cancellation(request.request_id, cancellation)


@router.post("/cancel-generation")
async def cancel_generation(request: CancelRequest | None = None):
    """Invalidate in-flight TTS work (page change / voice switch / document close)."""
    if request and request.request_id:
        with _request_cancellations_lock:
            cancellation = _request_cancellations.get(request.request_id)
        if cancellation:
            cancellation.cancel()
        return {"cancelled_request_id": request.request_id, "found": cancellation is not None}
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
        text = validate_narration_text_length(request.text)
        session_id = validate_session_id(request.session_id)
        page_index = validate_page_index(request.page_index)
        language_id = validate_language_id(request.language_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    async def event_stream():
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        cancellation = _register_cancellation(request.request_id)

        def deliver(item):
            loop.call_soon_threadsafe(queue.put_nowait, item)

        def run_sync():
            try:
                for event in narrate_text_streaming(
                    text, session_id, page_index, request.voice_id, language_id,
                    request.clip_suffix, cancellation,
                ):
                    deliver(event)
            except Exception as exc:  # noqa: BLE001 - surface to the client
                deliver(exc)

        # All model access must run on the dedicated priority worker. Running
        # progressive synthesis on asyncio's generic executor allowed it to
        # contend with preparation/model work and could invoke CUDA from an
        # unexpected thread.
        producer_future = submit_tts(_priority_from_str(request.priority), run_sync)

        try:
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
                    _cache_completed_page(request, text, page_index, item)
                    line["alignment_mode"] = alignment_mode()
                yield json.dumps(line) + "\n"
                if item.get("type") == "done":
                    await asyncio.wrap_future(producer_future)
                    return
        finally:
            cancellation.cancel()
            _release_cancellation(request.request_id, cancellation)

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")
