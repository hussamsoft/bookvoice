"""Studio narration: standalone clips and splice repair.

Voice Studio narration gets a small leading/trailing silence bed so
phonemes are not flush against the WAV boundary; repair synthesis
explicitly bypasses it because silence inside a splice would create an
audible gap.
"""
from __future__ import annotations

from services.path_utils import validate_language_id, validate_session_id

from . import synth as _synth


def narrate_studio_text(
    text: str,
    session_id: str,
    voice_id: str | None,
    language_id: str,
    generation_settings: dict,
    cancel_event=None,
    *,
    add_buffer_silence: bool = True,
) -> dict:
    """Generate one immutable Studio narration without touching the book cache."""
    filename = _synth._audio_filename(
        0,
        text,
        voice_id,
        validate_language_id(language_id),
        "studio",
        generation_settings,
    )
    return _synth._synthesize_audio(
        text,
        validate_session_id(session_id),
        filename,
        voice_id,
        language_id,
        cancel_event,
        generation_settings,
        _synth.STUDIO_LEADING_SILENCE_S if add_buffer_silence else 0.0,
        _synth.STUDIO_TRAILING_SILENCE_S if add_buffer_silence else 0.0,
    )


def narrate_studio_repair_text(
    text: str,
    session_id: str,
    voice_id: str | None,
    language_id: str,
    generation_settings: dict,
    cancel_event=None,
) -> dict:
    """Generate splice audio without the standalone narration safety bed."""
    return narrate_studio_text(
        text,
        session_id,
        voice_id,
        language_id,
        generation_settings,
        cancel_event,
        add_buffer_silence=False,
    )
