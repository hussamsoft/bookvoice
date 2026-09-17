"""Public surface for the TTS service.

The package was extracted from a single 1,907-line ``tts_service.py``
module; the public surface is preserved 1:1 so callers
(``main.py``, ``routes/tts.py``, ``services/studio_service.py``,
``services/generation_gateway.py``, ``services/book_library_service.py``)
see no change. Internally the work is split into:

- ``queue`` — single-threaded TTS lane + cooperative generation tokens
- ``model`` — model state, device resolution, lifecycle (preload/reload)
- ``synth`` — chunking, kwargs, full-page synthesis, session cleanup
- ``streaming`` — progressive-chunk narration, cached-page export, pronunciation cache
- ``conversion`` — voice conversion (S3Gen-only inference)
- ``studio`` — standalone Studio narration + repair synthesis
"""
from __future__ import annotations

# Re-exports preserve the legacy ``from services.tts_service import X``
# call sites. Tests that do ``patch("services.tts_service.X", ...)``
# continue to work because the package's ``__getattr__`` resolution
# finds the name here.

# Queue + cancellation
from .queue import (
    GenerationCancelled,
    GenerationCancellation,
    TtsPriority,
    TtsQueueFull,
    bump_generation,
    submit_tts,
    tts_queue_depth,
)

# Model lifecycle
from .model import (
    get_model,
    preload_model,
    request_reload,
    state_snapshot,
)

# Synthesis
from .synth import (
    narrate_text,
)

# Streaming
from .streaming import (
    export_cached_pages,
    narrate_text_streaming,
    pronounce_text,
)

# Conversion
from .conversion import (
    convert_voice_audio,
    conversion_filename,
    get_voice_converter,
)

# Studio
from .studio import (
    narrate_studio_repair_text,
    narrate_studio_text,
)


# Expose the model module so tests that previously reset
# ``services.tts_service._model = None`` can now target
# ``services.tts_service.model._model = None`` — the state lives here,
# not in the package namespace.
from . import model  # noqa: E402,F401
from . import queue  # noqa: E402,F401
from . import synth  # noqa: E402,F401
from . import streaming  # noqa: E402,F401
from . import conversion  # noqa: E402,F401
from . import studio  # noqa: E402,F401


__all__ = [
    # queue
    "GenerationCancelled",
    "GenerationCancellation",
    "TtsPriority",
    "TtsQueueFull",
    "bump_generation",
    "submit_tts",
    "tts_queue_depth",
    # model
    "get_model",
    "preload_model",
    "request_reload",
    "state_snapshot",
    # synth
    "narrate_text",
    # streaming
    "export_cached_pages",
    "narrate_text_streaming",
    "pronounce_text",
    # conversion
    "convert_voice_audio",
    "conversion_filename",
    "get_voice_converter",
    # studio
    "narrate_studio_repair_text",
    "narrate_studio_text",
    # submodules (for tests that reset internal state)
    "model",
    "queue",
    "synth",
    "streaming",
    "conversion",
    "studio",
]


# Forward attribute access on the package to its submodules. This keeps
# the legacy ``services.tts_service._audio_filename`` / ``_speech_windows``
# / ``VC_MAX_WINDOW_S`` paths working for tests that previously reached
# into the monolith's private namespace. ``__getattr__`` only runs when
# normal attribute lookup misses — the explicit re-exports above still
# win, and writes to module attributes (which tests no longer do after
# the setUp refactor) bypass this hook entirely.
#
# O(1) lookup per attribute (audit finding L-66). The previous dict-
# of-everything approach scanned every submodule at import time and
# walked a dict on every miss. Per-submodule dicts make the import
# cost grow with the number of public names in the package (small)
# instead of with every name in every submodule (larger).
_SUBMODULE_BY_NAME: dict[str, object] = {
    name: sub
    for sub in (queue, model, synth, streaming, conversion, studio)
    for name in dir(sub)
    if not name.startswith("__")
}


def __getattr__(name):
    sub = _SUBMODULE_BY_NAME.get(name)
    if sub is not None:
        return getattr(sub, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
