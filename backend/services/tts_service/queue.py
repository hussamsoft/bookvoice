"""TTS job queue and cooperative generation-cancellation tokens.

The TTS lane is single-threaded: every narration call, voice switch,
and prefix work item is funnelled through one PriorityQueue with one
worker. Concurrent generation requests are rejected past
``_TTS_MAX_QUEUED`` so a prefetch storm cannot park unbounded memory
behind a long CPU generation.

The generation token lets the worker honour page-change, voice-switch,
and document-close events by bumping a global counter. In-flight
multi-chunk syntheses check the token at every chunk boundary and raise
``GenerationCancelled`` when it has been superseded.
"""
from __future__ import annotations

import threading
from concurrent.futures import Future
from enum import IntEnum
from queue import PriorityQueue


# Priority levels for TTS jobs (lower number = higher priority).
class TtsPriority(IntEnum):
    INTERACTIVE = 0  # word pronounce, voice-switch partials
    CURRENT = 1      # active page narration
    PREFETCH = 2     # background prefetch
    PREPARE = 3      # resumable whole-book preparation


_tts_job_queue: PriorityQueue | None = None
_tts_queue_lock = threading.Lock()
_tts_seq = 0
_tts_worker_started = False


def _next_tts_seq() -> int:
    global _tts_seq
    with _tts_queue_lock:
        _tts_seq += 1
        return _tts_seq


def _tts_queue_worker() -> None:
    while True:
        _priority, _seq, fn, args, kwargs, future = _tts_job_queue.get()  # type: ignore[union-attr]
        try:
            if not future.cancelled():
                result = fn(*args, **kwargs)
                future.set_result(result)
        except Exception as exc:
            if not future.cancelled():
                future.set_exception(exc)
        except BaseException:
            # ``BaseException`` (KeyboardInterrupt, SystemExit) escapes an
            # ``except Exception`` block and would silently kill this
            # daemon thread, leaving every future TTS submission to hang
            # forever. Surface it on the future and keep the worker alive.
            import traceback
            if not future.cancelled():
                future.set_exception(
                    RuntimeError(
                        "TTS worker caught BaseException; the worker continues."
                    )
                )
                traceback.print_exc()
        finally:
            _tts_job_queue.task_done()  # type: ignore[union-attr]


def _ensure_tts_worker() -> None:
    global _tts_job_queue, _tts_worker_started
    with _tts_queue_lock:
        if _tts_worker_started:
            return
        _tts_job_queue = PriorityQueue()
        threading.Thread(target=_tts_queue_worker, name="tts-priority", daemon=True).start()
        _tts_worker_started = True


_TTS_MAX_QUEUED = 16


class TtsQueueFull(RuntimeError):
    """Raised when the TTS lane is saturated and callers should back off."""


def tts_queue_depth() -> int:
    """Number of jobs waiting for (or holding) the single TTS worker."""
    queue = _tts_job_queue
    return queue.qsize() if queue is not None else 0


def submit_tts(priority: TtsPriority, fn, *args, **kwargs) -> Future:
    """Submit a TTS job with priority (lower = sooner). Returns a Future."""
    _ensure_tts_worker()
    # The lane is single-threaded and each job can run for minutes on CPU.
    # Refusing to queue without bound keeps a prefetch storm or a second
    # client from parking unbounded memory and executor threads behind it.
    # Interactive work (pronunciation taps) always gets through.
    if priority > TtsPriority.INTERACTIVE and tts_queue_depth() >= _TTS_MAX_QUEUED:
        raise TtsQueueFull(
            "The narration engine is busy. Try again when the current audio finishes."
        )
    future: Future = Future()
    seq = _next_tts_seq()
    _tts_job_queue.put((int(priority), seq, fn, args, kwargs, future))  # type: ignore[union-attr]
    return future


# Cooperative generation cancellation: bumped on page change / voice switch /
# document close so an in-flight multi-chunk synthesis can abort at the next
# chunk boundary instead of blocking newer work.
_generation_token = 0
_generation_lock = threading.Lock()


class GenerationCancelled(RuntimeError):
    """Raised when a synthesis is superseded by a newer generation."""


class GenerationCancellation:
    """Request-scoped cooperative cancellation checked between TTS chunks."""

    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    def cancelled(self) -> bool:
        return self._event.is_set()


def bump_generation() -> int:
    """Invalidate all in-flight generations; returns the new token value."""
    global _generation_token
    with _generation_lock:
        _generation_token += 1
        return _generation_token


def _current_generation() -> int:
    with _generation_lock:
        return _generation_token


def _raise_if_cancelled(cancel_event: GenerationCancellation | None, started_token: int) -> None:
    if (cancel_event is not None and cancel_event.cancelled()) or _current_generation() != started_token:
        raise GenerationCancelled("generation was cancelled")
