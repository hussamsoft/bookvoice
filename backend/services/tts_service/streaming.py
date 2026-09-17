"""Streaming narration, cached-page export, and pronunciation cache.

The streaming module owns:
- ``narrate_text_streaming`` — progressive-chunk NDJSON for first-audio-early playback
- ``export_cached_pages`` — concatenate full-page WAVs into a downloadable clip
- ``pronounce_text`` — persistent deterministic word-pronunciation clips
- ``_trim_pronunciation_cache`` — LRU bound on the word cache
"""
from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

import torch
import torchaudio as ta

from services.path_utils import (
    safe_join,
    validate_language_id,
    validate_narration_text_length,
    validate_page_index,
    validate_session_id,
    validate_text_length,
    validate_voice_id,
)

from . import model as _model
from . import synth as _synth
from .queue import _current_generation, _raise_if_cancelled


_PRONUNCIATION_CACHE_LAST_TRIM: dict[str, float] = {}


def narrate_text_streaming(
    text,
    session_id,
    page_index,
    voice_id=None,
    language_id="en",
    clip_suffix: str | None = None,
    cancel_event=None,
):
    """Generator yielding progressive chunk events for first-audio-early playback.

    Yields dicts of shape {"type": "chunk", "index", "total", "url", "text",
    "start_s", "end_s"} as each chunk is synthesized, then a final
    {"type": "done", "audio_url", "segments", "duration_s", "word_timings"}.
    Respects the cooperative generation token (raises GenerationCancelled).

    The per-chunk files are saved immediately; the full-page concatenated file
    is also saved at the end so the existing cache-hit path and alignment still
    work unchanged.
    """
    text = validate_narration_text_length(text)
    session_id = validate_session_id(session_id)
    page_index = validate_page_index(page_index)
    language_id = validate_language_id(language_id)

    _synth.maybe_cleanup_sessions()
    model = _model.get_model(language_id)
    _, voices_dir, sessions_dir = _model._data_dirs()

    audio_prompt_path = None
    if voice_id:
        safe_id = validate_voice_id(
            "".join(c for c in voice_id if c.isalnum() or c in ("-", "_")).strip()
        )
        audio_prompt_path = safe_join(voices_dir, f"{safe_id}.wav")
        if not os.path.exists(audio_prompt_path):
            raise FileNotFoundError(f"Voice profile '{safe_id}' not found.")

    generate_kwargs = {}
    if audio_prompt_path:
        generate_kwargs["audio_prompt_path"] = audio_prompt_path

    chunks = _synth._split_into_chunks(text)
    total = len(chunks)
    device = getattr(model, "device", _model._resolve_device())
    sr = float(getattr(model, "sr", 24000) or 24000)

    # The full-page file shares the canonical batch-narration identity (text,
    # voice checksum, engine versions) so streaming and one-shot narration of
    # the same page resolve to the same cached audio instead of silently
    # diverging. Chunk files hang a _c{i} marker off that stem so the export
    # full-page pattern never mistakes a partial for a complete page.
    full_filename = _synth._audio_filename(page_index, text, voice_id, language_id, clip_suffix)
    chunk_stem = full_filename.removesuffix(".wav")

    output_dir = safe_join(sessions_dir, session_id)
    os.makedirs(output_dir, exist_ok=True)

    _model._log(
        f"[tts] stream file={full_filename} chars={len(text)} "
        f"chunks={total} device={device} lang={language_id}"
    )

    wav_parts: list[torch.Tensor] = []
    segment_meta: list[dict] = []
    chunk_urls: list[str] = []

    # Per-chunk lock acquisition mirrors synth.py:496 — the lock exists
    # to serialise inference so the model state stays consistent, not to
    # hold the whole multi-chunk synthesis. The cooperative
    # _raise_if_cancelled already serialises work between chunks.
    _model._model_state["status"] = "generating"
    started_token = _current_generation()
    try:
        cursor_s = 0.0
        for i, chunk in enumerate(chunks):
            _raise_if_cancelled(cancel_event, started_token)
            _model._model_state["detail"] = (
                f"Generating audio {i + 1}/{total} on {str(device).upper()}"
                + (" (CPU - slow; install CUDA torch for GPU)" if device == "cpu" else "")
            )
            kwargs = dict(generate_kwargs)
            if i > 0:
                kwargs.pop("audio_prompt_path", None)
            elif i == 0 and audio_prompt_path:
                kwargs["force_prepare"] = False
            with _synth._generate_lock:
                part = _synth._generate_chunk(model, chunk, language_id, **kwargs)
            if isinstance(part, torch.Tensor):
                part = part.detach().cpu()
            else:
                part = torch.as_tensor(part).cpu()
            if part.dim() == 1:
                part = part.unsqueeze(0)
            samples = int(part.shape[-1])
            dur = samples / sr if sr > 0 else 0.0

            # Save this chunk immediately so the client can play it now.
            chunk_file = f"{chunk_stem}_c{i}.wav"
            chunk_path = safe_join(output_dir, chunk_file)
            if part.dim() == 1:
                save_part = part.unsqueeze(0)
            else:
                save_part = part
            ta.save(chunk_path, save_part, model.sr)

            start_s = round(cursor_s, 4)
            end_s = round(cursor_s + dur, 4)
            chunk_url = f"/sessions/{session_id}/{chunk_file}"
            chunk_urls.append(chunk_url)
            segment_meta.append({"text": chunk, "start_s": start_s, "end_s": end_s})
            cursor_s += dur
            wav_parts.append(part)

            yield {
                "type": "chunk",
                "index": i,
                "total": total,
                "url": chunk_url,
                "text": chunk,
                "start_s": start_s,
                "end_s": end_s,
            }
    except _synth.GenerationCancelled:
        _model._model_state["status"] = "ready"
        _model._model_state["detail"] = f"Model ready on {str(device).upper()}."
        raise
    except Exception as e:
        _model._model_state["status"] = "ready"
        _model._model_state["detail"] = (
            f"Model ready on {str(device).upper()} "
            f"(last generation failed: {e})"
        )
        raise
    else:
        _model._model_state["status"] = "ready"
        _model._model_state["detail"] = f"Model ready on {str(device).upper()}."

    # Save the full concatenated file for cache hits + alignment.
    wav = _synth._concat_wavs(wav_parts)
    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    full_path = safe_join(output_dir, full_filename)
    ta.save(full_path, wav, model.sr)

    result = {
        "audio_url": f"/sessions/{session_id}/{full_filename}",
        "segments": segment_meta,
        "duration_s": round(float(wav.shape[-1]) / sr, 4) if sr > 0 else 0.0,
    }

    try:
        from services.alignment_service import align_words

        word_timings = align_words(text, full_path, language_id, segments=segment_meta)
        if word_timings:
            result["word_timings"] = word_timings
    except Exception as exc:  # noqa: BLE001 - alignment is optional
        _model._log(f"Forced alignment skipped, falling back to estimates: {exc}")

    result["type"] = "done"
    yield result


def export_cached_pages(session_id, start_page, end_page):
    """Concatenate the newest canonical full-page WAV for each requested page.

    Export deliberately operates only on completed full-page cache files. Chunk
    files and partial clips are excluded, and pages without an audio cache entry
    produce an actionable error instead of silently creating an incomplete book.
    """
    session_id = validate_session_id(session_id)
    start_page = validate_page_index(start_page)
    end_page = validate_page_index(end_page)
    if end_page < start_page:
        raise ValueError("end_page must be greater than or equal to start_page.")

    _, _, sessions_dir = _model._data_dirs()
    session_dir = safe_join(sessions_dir, session_id)
    if not os.path.isdir(session_dir):
        raise FileNotFoundError("No cached audio exists for this reading session.")

    full_page_re = re.compile(r"^page_(\d+)_([0-9a-f]{16})\.wav$")
    newest_by_page = {}
    for name in os.listdir(session_dir):
        match = full_page_re.match(name)
        if not match:
            continue
        page = int(match.group(1))
        if not start_page <= page <= end_page:
            continue
        path = safe_join(session_dir, name)
        previous = newest_by_page.get(page)
        if previous is None or os.path.getmtime(path) > os.path.getmtime(previous):
            newest_by_page[page] = path

    pages = list(range(start_page, end_page + 1))
    missing = [page for page in pages if page not in newest_by_page]
    if missing:
        missing_text = ", ".join(str(page) for page in missing)
        raise FileNotFoundError(f"Generate audio for page(s) {missing_text} before exporting.")

    wav_parts = []
    sample_rate = None
    source_names = []
    for page in pages:
        path = newest_by_page[page]
        wav, rate = ta.load(path)
        if sample_rate is None:
            sample_rate = rate
        elif rate != sample_rate:
            raise ValueError("Cached pages use incompatible audio sample rates.")
        wav_parts.append(wav)
        source_names.append(os.path.basename(path))

    combined = _synth._concat_wavs(wav_parts)
    if combined.dim() == 1:
        combined = combined.unsqueeze(0)
    digest = hashlib.sha256("\0".join(source_names).encode("utf-8")).hexdigest()[:12]
    filename = f"export_{start_page}-{end_page}_{digest}.wav"
    output_path = safe_join(session_dir, filename)
    ta.save(output_path, combined, sample_rate)
    return {
        "audio_url": f"/sessions/{session_id}/{filename}",
        "pages": pages,
        "duration_s": round(float(combined.shape[-1]) / sample_rate, 4),
    }


def pronounce_text(text, session_id, voice_id=None, language_id="en"):
    """Return a persistent deterministic pronunciation clip."""
    validate_session_id(session_id)
    text = validate_text_length(text)
    language_id = validate_language_id(language_id)
    _, voices_dir, sessions_dir = _model._data_dirs()
    safe_voice = voice_id or "default"
    voice_signature = safe_voice
    if voice_id:
        voice_path = safe_join(voices_dir, f"{validate_voice_id(voice_id)}.wav")
        if os.path.isfile(voice_path):
            stat = os.stat(voice_path)
            voice_signature = f"{safe_voice}:{stat.st_size}:{stat.st_mtime_ns}"
    model_dir = os.environ.get("MODEL_DIR", "")
    identity = "\0".join((text, language_id, voice_signature, model_dir))
    filename = f"clip_{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:20]}.wav"
    cache_session = "pronunciation-cache"
    cache_dir = safe_join(sessions_dir, cache_session)
    cache_path = safe_join(cache_dir, filename)
    if os.path.isfile(cache_path):
        os.utime(cache_path, None)
        return {"audio_url": f"/sessions/{cache_session}/{filename}"}
    result = _synth._synthesize_audio(text, cache_session, filename, voice_id, language_id)
    _trim_pronunciation_cache(cache_dir)
    return result


def _trim_pronunciation_cache(cache_dir: str, max_files: int = 1000) -> None:
    """Bound the persistent word cache by least-recently-used file time."""
    try:
        dir_mtime = os.stat(cache_dir).st_mtime
        if _PRONUNCIATION_CACHE_LAST_TRIM.get(cache_dir) == dir_mtime:
            return
        files = sorted(
            (entry for entry in os.scandir(cache_dir) if entry.is_file() and entry.name.endswith(".wav")),
            key=lambda entry: entry.stat().st_mtime,
            reverse=True,
        )
        for entry in files[max_files:]:
            os.remove(entry.path)
        _PRONUNCIATION_CACHE_LAST_TRIM[cache_dir] = dir_mtime
    except OSError:
        pass
