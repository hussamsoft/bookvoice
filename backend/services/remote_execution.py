"""Optional off-process execution for GPU work.

The desktop app runs generation in-process on the machine the person is sitting
at. A hosted deployment can instead attach the GPU to short-lived worker
containers, so the web process — which spends most of its life idle while
someone reads or types — never holds one.

Nothing here is active unless a deployment registers an executor. When none is
registered, callers run generation locally exactly as before.
"""
from __future__ import annotations

import threading
from typing import Any, Callable, Protocol


class Executor(Protocol):
    """Runs one named generation job somewhere else and returns its result.

    ``cancel_check`` is polled while the remote job runs so a cancelled Studio
    job can stop paying for a worker it no longer needs.
    """

    def __call__(
        self,
        kind: str,
        payload: dict[str, Any],
        *,
        cancel_check: Callable[[], bool] | None = None,
        progress: Callable[[float], None] | None = None,
    ) -> dict:
        ...


_executor: Executor | None = None
_lock = threading.Lock()


def set_executor(executor: Executor | None) -> None:
    """Register (or clear) the process that runs generation jobs."""
    global _executor
    with _lock:
        _executor = executor


def executor() -> Executor | None:
    with _lock:
        return _executor


def is_remote() -> bool:
    return executor() is not None
