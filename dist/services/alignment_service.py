"""Optional forced-alignment for word-level timestamps via Whisper."""
from __future__ import annotations

import importlib.util
import logging
import os
import re

_log = logging.getLogger(__name__)

_whisper_model = None
_whisper_lock = __import__("threading").Lock()


def alignment_mode() -> str:
    """Report how word timings are being produced.

    Returns one of:
      - "disabled": DISABLED_FORCED_ALIGNMENT is set.
      - "whisper":   the openai-whisper package is importable (real alignment).
      - "estimate":  whisper is unavailable; timings come from client-side estimates.
    """
    if os.getenv("DISABLE_FORCED_ALIGNMENT", "").strip().lower() in ("1", "true", "yes"):
        return "disabled"
    return "whisper" if importlib.util.find_spec("whisper") is not None else "estimate"



def _normalize_word(w: str) -> str:
    return re.sub(r"[^\w\u0600-\u06FF']", "", w or "").lower()


def align_words(text: str, audio_path: str, language_id: str = "en") -> list[dict] | None:
    """
    Return [{word, start_s, end_s}, ...] aligned to narrated text, or None if
    Whisper is unavailable or alignment fails.
    """
    if os.getenv("DISABLE_FORCED_ALIGNMENT", "").strip().lower() in ("1", "true", "yes"):
        return None

    words = [w for w in re.split(r"\s+", text.strip()) if w]
    if not words or not os.path.isfile(audio_path):
        return None

    try:
        import whisper  # type: ignore[import-untyped]
    except ImportError:
        return None

    global _whisper_model
    model_name = os.getenv("WHISPER_MODEL", "base")
    lang = "ar" if language_id == "ar" else "en"

    try:
        with _whisper_lock:
            if _whisper_model is None:
                _log.info("Loading Whisper model %s for forced alignment", model_name)
                _whisper_model = whisper.load_model(model_name)
            result = _whisper_model.transcribe(
                audio_path,
                language=lang,
                word_timestamps=True,
                fp16=False,
            )
    except Exception as exc:
        _log.warning("Forced alignment failed: %s", exc)
        return None

    whisper_words: list[dict] = []
    for seg in result.get("segments") or []:
        for w in seg.get("words") or []:
            token = (w.get("word") or "").strip()
            if token:
                whisper_words.append(
                    {
                        "word": token,
                        "start_s": float(w.get("start") or 0),
                        "end_s": float(w.get("end") or 0),
                    }
                )

    if not whisper_words:
        return None

    # Map narrated words to whisper tokens sequentially.
    aligned: list[dict] = []
    wi = 0
    for word in words:
        target = _normalize_word(word)
        if not target:
            continue
        found = None
        for j in range(wi, min(wi + 5, len(whisper_words))):
            if _normalize_word(whisper_words[j]["word"]) == target:
                found = whisper_words[j]
                wi = j + 1
                break
        if found:
            aligned.append(
                {
                    "word": word,
                    "start_s": round(found["start_s"], 4),
                    "end_s": round(found["end_s"], 4),
                }
            )
        elif aligned:
            # Interpolate from last known timing
            last = aligned[-1]
            aligned.append(
                {
                    "word": word,
                    "start_s": last["end_s"],
                    "end_s": last["end_s"] + 0.15,
                }
            )

    if len(aligned) < len(words) * 0.5:
        return None
    return aligned
