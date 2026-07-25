"""One dispatch point for every piece of GPU work Voice Studio performs.

Locally this is a thin pass-through to ``tts_service``'s priority queue — the
desktop app behaves exactly as it did before this module existed. In a hosted
deployment an executor is registered (see :mod:`services.remote_execution`) and
the same calls run in a short-lived GPU container instead, so the web process
never holds a GPU while someone is reading or typing.

Job kinds are addressed by name rather than by function reference because the
remote side has to resolve them in a different process.
"""
from __future__ import annotations

from typing import Any, Callable

from services import remote_execution


NARRATE = "narrate_studio"
NARRATE_REPAIR = "narrate_studio_repair"
CONVERT = "convert_voice"


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


def run_remote_job(kind: str, payload: dict[str, Any], progress=None) -> dict:
    """Execute a job in-process. Called by the worker on the far side."""
    return _run_local(kind, payload, None, progress)


def dispatch(
    kind: str,
    payload: dict[str, Any],
    *,
    cancellation=None,
    cancel_check: Callable[[], bool] | None = None,
    progress: Callable[[float], None] | None = None,
) -> dict:
    """Run a generation job locally, or remotely when an executor is registered."""
    executor = remote_execution.executor()
    if executor is None:
        return _run_local(kind, payload, cancellation, progress)
    check = cancel_check
    if check is None and cancellation is not None:
        check = cancellation.cancelled
    return executor(kind, payload, cancel_check=check, progress=progress)


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
            "sourcePath": str(source_path),
            "targetVoicePath": str(target_voice_path),
            "sessionId": session_id,
            "filename": filename,
        },
        cancellation=cancellation,
        progress=progress,
    )
