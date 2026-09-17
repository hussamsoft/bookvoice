"""One dispatch point for every piece of GPU work Voice Studio performs.

Locally this is a thin pass-through to ``tts_service``'s priority queue —
the desktop app behaves exactly as it did before this module existed.
The legacy ``services.remote_execution`` executor hook (audit
finding C-37) was removed in 2.8.0; a hosted deployment that wants
remote execution should re-add an optional dispatch path.

Job kinds are addressed by name rather than by function reference so
that a future remote-execution implementation can resolve them in a
different process.
"""
from __future__ import annotations

from pathlib import PurePath
from typing import Any, Callable


NARRATE = "narrate_studio"
NARRATE_REPAIR = "narrate_studio_repair"
CONVERT = "convert_voice"


def _payload_path(path: str | PurePath) -> str:
    """Serialize a filesystem path without leaking the caller OS's separators."""
    return path.as_posix() if isinstance(path, PurePath) else str(path)


def _run_local(kind: str, payload: dict[str, Any], cancellation, progress):
    from services import tts_service

    if kind == NARRATE:
        return tts_service.submit_tts(
            tts_service.TtsPriority.CURRENT,
            tts_service.narrate_studio_text,
            payload["text"],
            payload["sessionId"],
            payload["voiceId"],
            payload["languageId"],
            payload["generationSettings"],
            cancellation,
        ).result()
    if kind == NARRATE_REPAIR:
        # Repair is a short, interactive edit and jumps the queue, as before.
        return tts_service.submit_tts(
            tts_service.TtsPriority.INTERACTIVE,
            tts_service.narrate_studio_repair_text,
            payload["text"],
            payload["sessionId"],
            payload["voiceId"],
            payload["languageId"],
            payload["generationSettings"],
            cancellation,
        ).result()
    if kind == CONVERT:
        return tts_service.submit_tts(
            tts_service.TtsPriority.CURRENT,
            tts_service.convert_voice_audio,
            payload["sourcePath"],
            payload["targetVoicePath"],
            payload["sessionId"],
            payload["filename"],
            cancellation,
            progress=progress,
        ).result()
    raise ValueError(f"Unknown generation job: {kind}")


def dispatch(
    kind: str,
    payload: dict[str, Any],
    *,
    cancellation=None,
    cancel_check: Callable[[], bool] | None = None,
    progress: Callable[[float], None] | None = None,
) -> dict:
    """Run a generation job locally.

    The legacy ``services.remote_execution`` executor hook was removed
    in 2.8.0 (audit finding C-37); when no executor is registered
    we always run locally. If a hosted deployment later wants remote
    execution it should re-add the optional dispatch path with the
    same call signature.
    """
    return _run_local(kind, payload, cancellation, progress)


def narrate(session_id: str, text: str, language_id: str, voice_id, settings: dict, *,
            cancellation=None) -> dict:
    return dispatch(
        NARRATE,
        {
            "text": text,
            "sessionId": session_id,
            "voiceId": voice_id,
            "languageId": language_id,
            "generationSettings": settings,
        },
        cancellation=cancellation,
    )


def narrate_repair(session_id: str, text: str, language_id: str, voice_id, settings: dict, *,
                   cancellation=None) -> dict:
    return dispatch(
        NARRATE_REPAIR,
        {
            "text": text,
            "sessionId": session_id,
            "voiceId": voice_id,
            "languageId": language_id,
            "generationSettings": settings,
        },
        cancellation=cancellation,
    )


def convert(session_id: str, source_path: str, target_voice_path: str, filename: str, *,
            cancellation=None, progress=None) -> dict:
    return dispatch(
        CONVERT,
        {
            "sourcePath": _payload_path(source_path),
            "targetVoicePath": _payload_path(target_voice_path),
            "sessionId": session_id,
            "filename": filename,
        },
        cancellation=cancellation,
        progress=progress,
    )
