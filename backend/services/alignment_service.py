"""Word-level timestamp alignment for narrated audio.

Tiers, most accurate first:

1. "ctc" — CTC forced alignment of the *known* narrated text against a bundled
   wav2vec2 acoustic model (``torchaudio.functional.forced_align``). Because
   the transcript is the exact TTS input, every word receives a measured
   [start, end] span by construction — there is no transcription step that can
   substitute, split, or drop words. When the synthesized chunk boundaries are
   provided, alignment runs independently per chunk, so timing error can never
   accumulate across sentences. Model weights live under
   ``MODEL_DIR/alignment/<language_id>/`` (staged by
   scripts/prepare_alignment_model.py, bundled by build.py).

2. "whisper" — legacy fallback: openai-whisper transcription with word
   timestamps, fuzzy-matched back to the narrated words. Only used when the
   whisper package is installed and no CTC model is bundled.

3. "estimate" — no aligner available; the frontend derives timings from
   measured chunk durations and character-weight heuristics.
"""
from __future__ import annotations

import importlib.util
import json
import logging
import os
import re
import threading
import unicodedata

_log = logging.getLogger(__name__)

_whisper_model = None
_whisper_lock = threading.Lock()

_ctc_lock = threading.Lock()
_ctc_cache: dict[str, tuple] = {}
_ctc_failed: set[str] = set()

# Guard rails for the acoustic pass.
_CTC_SAMPLE_RATE = 16000
_CTC_MAX_SEGMENT_S = 240.0
_CTC_MIN_COVERAGE = 0.6

_WORD_SPLIT = re.compile(r"\s+")


def _split_words(text: str) -> list[str]:
    """Split narrated text exactly like the frontend transcript does."""
    return [w for w in _WORD_SPLIT.split(str(text or "").strip()) if w]


def _model_root() -> str:
    env = os.environ.get("MODEL_DIR", "").strip()
    if env:
        return env
    backend = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(backend, "data", "models")


def _ctc_model_dir(language_id: str) -> str | None:
    path = os.path.join(_model_root(), "alignment", language_id)
    if os.path.isfile(os.path.join(path, "config.json")) and os.path.isfile(
        os.path.join(path, "model.safetensors")
    ):
        return path
    return None


def _ctc_available(language_id: str) -> bool:
    if language_id in _ctc_failed:
        return False
    if _ctc_model_dir(language_id) is None:
        return False
    return (
        importlib.util.find_spec("torch") is not None
        and importlib.util.find_spec("torchaudio") is not None
        and importlib.util.find_spec("transformers") is not None
    )


def alignment_mode(language_id: str = "en") -> str:
    """Report how word timings are being produced.

    Returns one of "disabled", "ctc", "whisper", or "estimate".
    """
    if os.getenv("DISABLE_FORCED_ALIGNMENT", "").strip().lower() in ("1", "true", "yes"):
        return "disabled"
    if _ctc_available(language_id):
        return "ctc"
    return "whisper" if importlib.util.find_spec("whisper") is not None else "estimate"


def align_words(
    text: str,
    audio_path: str,
    language_id: str = "en",
    segments: list[dict] | None = None,
) -> list[dict] | None:
    """Return [{word, start_s, end_s}, ...] for the narrated text, or None.

    ``segments`` are the synthesized chunk boundaries
    ([{text, start_s, end_s}, ...]); when they cover the text exactly, each
    chunk is aligned independently against its own audio slice.
    """
    if os.getenv("DISABLE_FORCED_ALIGNMENT", "").strip().lower() in ("1", "true", "yes"):
        return None

    words = _split_words(text)
    if not words or not os.path.isfile(audio_path):
        return None

    if _ctc_available(language_id):
        try:
            aligned = _ctc_align(words, audio_path, language_id, segments)
            if aligned:
                return aligned
            _log.warning("CTC alignment produced no result; trying fallbacks")
        except Exception as exc:  # noqa: BLE001 - alignment must never break narration
            _ctc_failed.add(language_id)
            _log.warning("CTC alignment failed (%s); falling back", exc)

    return _whisper_align(words, audio_path, language_id)


# ---------------------------------------------------------------------------
# Tier 1: CTC forced alignment
# ---------------------------------------------------------------------------

def _load_ctc(language_id: str):
    """Load (model, vocab, blank_id, device) once per language."""
    with _ctc_lock:
        bundle = _ctc_cache.get(language_id)
        if bundle is not None:
            return bundle

        model_dir = _ctc_model_dir(language_id)
        if model_dir is None:
            raise FileNotFoundError(f"No alignment model for '{language_id}'")

        import torch
        from transformers import Wav2Vec2ForCTC

        with open(os.path.join(model_dir, "vocab.json"), encoding="utf-8") as handle:
            vocab = json.load(handle)

        try:
            model = Wav2Vec2ForCTC.from_pretrained(model_dir, dtype="auto")
        except TypeError:  # transformers < 5 uses torch_dtype
            model = Wav2Vec2ForCTC.from_pretrained(model_dir, torch_dtype="auto")

        device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cuda":
            model = model.half().to(device)
        else:
            # fp16 matmuls are unsupported/slow on CPU; upcast.
            model = model.float()
        model.eval()

        blank_id = int(getattr(model.config, "pad_token_id", 0) or 0)
        bundle = (model, vocab, blank_id, device)
        _ctc_cache[language_id] = bundle
        _log.info("Loaded CTC alignment model for '%s' on %s", language_id, device)
        return bundle


def _word_token_ids(word: str, vocab: dict) -> list[int]:
    """Map one narrated word onto the model's character vocabulary."""
    # Fold typographic apostrophes and strip diacritics so "café’s" anchors.
    normalized = unicodedata.normalize("NFKD", word).replace("’", "'")
    ids = []
    for char in normalized.upper():
        if unicodedata.combining(char):
            continue
        if char == "|":
            continue
        token = vocab.get(char)
        if token is not None:
            ids.append(int(token))
    return ids


def _segment_word_ranges(
    words: list[str], segments: list[dict] | None, duration_s: float
) -> list[tuple[int, int, float, float]]:
    """Split the word list into (word_start, word_end, start_s, end_s) chunks.

    Falls back to one whole-audio chunk when the segment texts do not
    reproduce the narrated word sequence exactly.
    """
    if segments:
        ranges: list[tuple[int, int, float, float]] = []
        cursor = 0
        for seg in segments:
            seg_words = _split_words(seg.get("text", ""))
            if not seg_words:
                continue
            start_s = float(seg.get("start_s") or 0.0)
            end_s = float(seg.get("end_s") or 0.0)
            if not (0 <= start_s < end_s):
                break
            if words[cursor : cursor + len(seg_words)] != seg_words:
                break
            ranges.append((cursor, cursor + len(seg_words), start_s, end_s))
            cursor += len(seg_words)
        else:
            if cursor == len(words) and ranges:
                return ranges
    return [(0, len(words), 0.0, duration_s)]


def _ctc_align(
    words: list[str],
    audio_path: str,
    language_id: str,
    segments: list[dict] | None,
) -> list[dict] | None:
    import torch
    import torchaudio

    model, vocab, blank_id, device = _load_ctc(language_id)
    word_sep = vocab.get("|")

    waveform, sample_rate = torchaudio.load(audio_path)
    if waveform.dim() > 1:
        waveform = waveform.mean(dim=0)
    if sample_rate != _CTC_SAMPLE_RATE:
        waveform = torchaudio.functional.resample(waveform, sample_rate, _CTC_SAMPLE_RATE)
    total_samples = int(waveform.shape[-1])
    duration_s = total_samples / _CTC_SAMPLE_RATE
    if duration_s <= 0:
        return None

    spans: list[tuple[float, float] | None] = [None] * len(words)

    for word_lo, word_hi, start_s, end_s in _segment_word_ranges(words, segments, duration_s):
        seg_len_s = min(end_s, duration_s) - start_s
        if seg_len_s <= 0 or seg_len_s > _CTC_MAX_SEGMENT_S:
            continue
        lo = int(start_s * _CTC_SAMPLE_RATE)
        hi = min(int(end_s * _CTC_SAMPLE_RATE), total_samples)
        segment_wave = waveform[lo:hi]
        if segment_wave.shape[-1] < _CTC_SAMPLE_RATE // 50:
            continue

        # Build the target token sequence and remember each word's token span.
        target: list[int] = []
        token_spans: list[tuple[int, int, int]] = []  # (word_index, lo, hi)
        for wi in range(word_lo, word_hi):
            ids = _word_token_ids(words[wi], vocab)
            if not ids:
                continue
            if target and word_sep is not None:
                target.append(int(word_sep))
            token_spans.append((wi, len(target), len(target) + len(ids)))
            target.extend(ids)
        if not target:
            continue

        try:
            emission = _ctc_emission(model, segment_wave, device)
        except Exception as exc:  # noqa: BLE001 - skip segment, keep the rest
            _log.warning("CTC emission failed for segment at %.2fs: %s", start_s, exc)
            continue

        frames = emission.shape[1]
        if frames < len(target):
            continue

        targets = torch.tensor([target], dtype=torch.int32)
        aligned, scores = torchaudio.functional.forced_align(
            emission, targets, blank=blank_id
        )
        merged = torchaudio.functional.merge_tokens(aligned[0], scores[0], blank=blank_id)
        if len(merged) != len(target):
            continue

        seconds_per_frame = (segment_wave.shape[-1] / frames) / _CTC_SAMPLE_RATE
        for wi, tok_lo, tok_hi in token_spans:
            first = merged[tok_lo]
            last = merged[tok_hi - 1]
            word_start = start_s + first.start * seconds_per_frame
            word_end = start_s + last.end * seconds_per_frame
            if word_end > word_start:
                spans[wi] = (word_start, word_end)

    anchored = sum(1 for s in spans if s is not None)
    if anchored < max(1, len(words) * _CTC_MIN_COVERAGE):
        return None

    _fill_unanchored(spans, duration_s)
    _extend_into_gaps(spans, duration_s)
    _enforce_monotonic(spans, duration_s)

    return [
        {"word": word, "start_s": round(span[0], 4), "end_s": round(span[1], 4)}
        for word, span in zip(words, spans)
    ]


def _ctc_emission(model, segment_wave, device: str):
    """Run the acoustic model over one chunk and return CPU log-probs."""
    import torch

    x = segment_wave
    # facebook/wav2vec2-base-960h expects zero-mean/unit-variance input.
    x = (x - x.mean()) / torch.sqrt(x.var() + 1e-7)
    x = x.unsqueeze(0).to(device=device, dtype=next(model.parameters()).dtype)
    with torch.inference_mode():
        logits = model(x).logits
    return torch.log_softmax(logits.float().cpu(), dim=-1)


def _fill_unanchored(spans: list, duration_s: float) -> None:
    """Interpolate words the vocabulary could not anchor (digits, symbols)."""
    n = len(spans)
    i = 0
    while i < n:
        if spans[i] is not None:
            i += 1
            continue
        gap_lo = i
        while i < n and spans[i] is None:
            i += 1
        gap_hi = i  # exclusive
        prev_end = spans[gap_lo - 1][1] if gap_lo > 0 else 0.0
        next_start = spans[gap_hi][0] if gap_hi < n else min(duration_s, prev_end + 0.3 * (gap_hi - gap_lo))
        span_width = max(next_start - prev_end, 0.02 * (gap_hi - gap_lo))
        step = span_width / (gap_hi - gap_lo)
        for k in range(gap_lo, gap_hi):
            start = prev_end + step * (k - gap_lo)
            spans[k] = (start, start + step)


def _extend_into_gaps(spans: list, duration_s: float) -> None:
    """Stretch word tails into the following silence.

    CTC emissions are spiky: a token's span ends at its emission peak, often
    before the acoustic tail of the word (trailing consonants, vowels fading
    out). Give each word most of the silence that follows it so replaying the
    span speaks the whole word.
    """
    for i in range(len(spans) - 1):
        start, end = spans[i]
        gap = spans[i + 1][0] - end
        if gap > 0:
            spans[i] = (start, end + min(gap * 0.7, 0.25))
    if spans:
        start, end = spans[-1]
        spans[-1] = (start, min(end + 0.25, duration_s))


def _enforce_monotonic(spans: list, duration_s: float) -> None:
    """Clamp spans to be finite, ordered, and inside the audio."""
    prev = 0.0
    for i, (start, end) in enumerate(spans):
        start = min(max(start, prev), duration_s)
        end = min(max(end, start + 0.01), duration_s + 0.25)
        spans[i] = (start, end)
        prev = start


# ---------------------------------------------------------------------------
# Tier 2: Whisper transcription fallback
# ---------------------------------------------------------------------------

def _normalize_word(w: str) -> str:
    return re.sub(r"[^\w؀-ۿ']", "", w or "").lower()


def _whisper_align(words: list[str], audio_path: str, language_id: str) -> list[dict] | None:
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
