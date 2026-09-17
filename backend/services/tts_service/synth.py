"""Narration synthesis: chunking, generation kwargs, single-chunk
inference, full-page synthesis, immutable filename, and session cleanup.

The synthesis module owns the per-generation lock (``_generate_lock``)
that serialises inference across ``_synthesize_audio``,
``convert_voice_audio``, and ``narrate_text_streaming`` so the model
state is consistent throughout a session. It also owns the Studio
silence-bounds constants used by both standalone narration and
repair synthesis.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
import torch
import torchaudio as ta

from services import media_tools
from services import config_service
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
from .queue import (
    GenerationCancellation,
    GenerationCancelled,
    TtsPriority,
    _current_generation,
    _raise_if_cancelled,
)


# Cross-cutting locks. ``_generate_lock`` serialises inference across
# synthesis, conversion, and streaming so the model state stays consistent.
_generate_lock = threading.Lock()

# Session-cleanup cadence. The disk reaper is on a 1 h tick because the
# data is cheap to re-narrate; the hourly cadence keeps the cleanup
# itself off the hot path.
_SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600
_SESSION_CLEANUP_INTERVAL = 3600
_last_cleanup = 0.0


# Standalone Studio narration gets a small safety bed so the first and last
# phonemes are not flush against the WAV boundary. Repair synthesis explicitly
# bypasses this because silence inside a splice would create an audible gap.
STUDIO_LEADING_SILENCE_S = 0.30
STUDIO_TRAILING_SILENCE_S = 0.40
STUDIO_GENERATION_PIPELINE_VERSION = "studio-dry-voice-v3"
PACE_TOLERANCE = 0.0001


_CHUNK_FILE_RE = re.compile(r"_c\d+\.wav$")
_CHUNK_GRACE_SECONDS = 3600


def _safe_exaggeration(expression: float) -> float:
    """Map the public 0..1 control onto Chatterbox's stable speech range."""
    value = max(0.0, min(1.0, float(expression)))
    if value <= 0.5:
        return 0.4 + (value * 0.2)
    return 0.5 + ((value - 0.5) * 0.4)


def _auto_guidance(expression: float) -> float:
    value = max(0.0, min(1.0, float(expression)))
    return 0.5 - (value * 0.2)


def _generation_kwargs(settings: dict | None, *, chunk_index: int = 0) -> dict:
    """Map the stable Studio settings contract onto Chatterbox parameters."""
    if not settings:
        return {}
    expression = float(settings.get("expression", 0.5))
    result = {
        "exaggeration": _safe_exaggeration(expression),
        "temperature": float(settings.get("temperature", 0.8)),
    }
    guidance = settings.get("guidance")
    if guidance is not None:
        try:
            cfg_weight = float(guidance)
        except (TypeError, ValueError):
            cfg_weight = _auto_guidance(expression)
        else:
            if not cfg_weight > 0.0:
                # 0.0, negatives, and NaN cannot disable CFG: the batch-2
                # contract inside t3.py requires doubled tokens, and a 0.0
                # weight saves no compute. Fall back to the automatic value.
                cfg_weight = _auto_guidance(expression)
            elif cfg_weight > 1.0:
                cfg_weight = 1.0
        result["cfg_weight"] = cfg_weight
    else:
        result["cfg_weight"] = _auto_guidance(expression)
    seed = settings.get("seed")
    if seed is not None:
        result["seed"] = (int(seed) + int(chunk_index)) % 4_294_967_296
    return result


def _apply_pace(
    wav: torch.Tensor,
    pace: float,
    sample_rate: int,
    *,
    cancel_check=None,
) -> torch.Tensor:
    if abs(float(pace) - 1.0) < 0.0001:
        return wav
    with tempfile.TemporaryDirectory(prefix="bookvoice-pace-") as temp_dir:
        source_path = Path(temp_dir) / "source.f32le"
        target_path = Path(temp_dir) / "paced.f32le"
        source = (
            wav.detach()
            .cpu()
            .float()
            .transpose(0, 1)
            .contiguous()
            .numpy()
            .astype("<f4", copy=False)
        )
        source.tofile(source_path)
        channels = int(wav.shape[0])
        try:
            media_tools.run_media_tool(
                "ffmpeg",
                [
                    "-y",
                    "-v",
                    "error",
                    "-f",
                    "f32le",
                    "-ar",
                    str(int(sample_rate)),
                    "-ac",
                    str(channels),
                    "-i",
                    str(source_path),
                    "-filter:a",
                    f"atempo={float(pace):.4f}",
                    "-acodec",
                    "pcm_f32le",
                    "-f",
                    "f32le",
                    str(target_path),
                ],
                timeout=600,
                cancel_check=cancel_check,
            )
        except media_tools.MediaToolCancelled as exc:
            raise GenerationCancelled("generation was cancelled") from exc
        adjusted = np.fromfile(target_path, dtype="<f4")
        if adjusted.size == 0 or adjusted.size % channels:
            raise RuntimeError("Pace processing returned invalid audio.")
        adjusted = adjusted.reshape((-1, channels)).T.copy()
        return torch.from_numpy(adjusted)


def _estimate_max_new_tokens(text: str) -> int:
    """
    Cap speech-token generation to what the text actually needs.
    Chatterbox defaults to max_new_tokens=1000 which is far too high for short
    chunks and makes CPU generation take minutes per chunk.
    """
    n = max(1, len(text.strip()))
    # ~1.6 speech tokens per character is generous for English/Arabic TTS.
    est = int(n * 1.6) + 48
    if _model._is_cuda_build():
        # Cap at the stock 1000 so long chunks are never cut off mid-sentence;
        # the estimate (not the cap) is what saves time on typical chunks.
        return max(80, min(1000, est))
    # CPU: keep the budget tight so a chunk finishes in a reasonable time.
    # 500 covers the largest CPU chunk (260 chars -> ~464 tokens estimated).
    return max(64, min(500, est))


def _generate_chunk(model, text: str, language_id: str, **generate_kwargs):
    """
    Call Chatterbox generate with a text-length-aware speech-token budget.
    The stock generate() hardcodes max_new_tokens=1000 which is extremely slow
    on CPU and wasteful even on GPU.
    """
    import torch.nn.functional as F

    max_new_tokens = _estimate_max_new_tokens(text)
    # t3.inference always runs the CFG batch of two (bos_embed and each step's
    # token embed are doubled unconditionally); cfg_weight only scales the
    # interpolation. A 0.0 default therefore saves no compute on CPU and breaks
    # the batch-2 contract inside t3.py (tensor-size mismatch at the first cat).
    cfg_weight = generate_kwargs.get("cfg_weight")
    if cfg_weight is None:
        cfg_weight = 0.4
    temperature = generate_kwargs.get("temperature", 0.8)
    repetition_penalty = generate_kwargs.get("repetition_penalty", 1.2)
    min_p = generate_kwargs.get("min_p", 0.05)
    top_p = generate_kwargs.get("top_p", 1.0)
    exaggeration = generate_kwargs.get("exaggeration", 0.5)
    audio_prompt_path = generate_kwargs.get("audio_prompt_path")
    force_prepare = bool(generate_kwargs.get("force_prepare", False))
    seed = generate_kwargs.get("seed")

    if audio_prompt_path:
        _model._prepare_voice_conditionals(model, audio_prompt_path, force=force_prepare)
        _model._last_voice_prompt = audio_prompt_path
        _model._last_voice_exaggeration = exaggeration
    elif model.conds is None:
        raise RuntimeError("Model has no speaker conditionals; select a voice or reinstall models.")

    # Multilingual path needs language_id
    is_mtl = language_id != "en" or type(model).__name__ == "ChatterboxMultilingualTTS"

    # Normalize + tokenize
    if is_mtl:
        from chatterbox.mtl_tts import punc_norm
        text_norm = punc_norm(text)
        text_tokens = model.tokenizer.text_to_tokens(
            text_norm, language_id=language_id.lower() if language_id else None
        ).to(model.device)
    else:
        from chatterbox.tts import punc_norm
        text_norm = punc_norm(text)
        text_tokens = model.tokenizer.text_to_tokens(text_norm).to(model.device)

    if exaggeration != model.conds.t3.emotion_adv[0, 0, 0]:
        from chatterbox.models.t3.modules.cond_enc import T3Cond

        _cond = model.conds.t3
        model.conds.t3 = T3Cond(
            speaker_emb=_cond.speaker_emb,
            cond_prompt_speech_tokens=_cond.cond_prompt_speech_tokens,
            emotion_adv=exaggeration * torch.ones(1, 1, 1),
        ).to(device=model.device)

    if cfg_weight > 0.0:
        text_tokens = torch.cat([text_tokens, text_tokens], dim=0)

    sot = model.t3.hp.start_text_token
    eot = model.t3.hp.stop_text_token
    text_tokens = F.pad(text_tokens, (1, 0), value=sot)
    text_tokens = F.pad(text_tokens, (0, 1), value=eot)

    t0 = time.perf_counter()
    # ``torch.random.fork_rng`` is a no-op when ``enabled=False``; the fork
    # is only required when an explicit seed is requested (otherwise the
    # serialised inference is already deterministic under
    # ``_generate_lock``). See _synthesize_audio for the lock contract.
    with torch.random.fork_rng(enabled=seed is not None):
        if seed is not None:
            torch.manual_seed(int(seed))
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(int(seed))
        with torch.inference_mode():
            speech_tokens = model.t3.inference(
                t3_cond=model.conds.t3,
                text_tokens=text_tokens,
                max_new_tokens=max_new_tokens,
                temperature=temperature,
                cfg_weight=cfg_weight,
                repetition_penalty=repetition_penalty,
                min_p=min_p,
                top_p=top_p,
            )
            speech_tokens = speech_tokens[0]
            from chatterbox.models.s3tokenizer import drop_invalid_tokens

            speech_tokens = drop_invalid_tokens(speech_tokens)
            speech_tokens = speech_tokens[speech_tokens < 6561]
            speech_tokens = speech_tokens.to(model.device)

            wav, _ = model.s3gen.inference(
                speech_tokens=speech_tokens,
                ref_dict=model.conds.gen,
            )
            wav = wav.squeeze(0).detach().cpu().numpy()
            # Watermark is optional quality; skip on CPU to save time
            if _model._is_cuda_build() and getattr(model, "watermarker", None) is not None:
                try:
                    wav = model.watermarker.apply_watermark(wav, sample_rate=model.sr)
                except Exception as e:
                    _model._log(f"Watermark skipped: {e}")

    elapsed = time.perf_counter() - t0
    _model._log(
        f"[tts] chunk {len(text)} chars -> max_tokens={max_new_tokens} "
        f"cfg={cfg_weight} device={model.device} took {elapsed:.1f}s"
    )
    return torch.from_numpy(wav).unsqueeze(0)


def _split_into_chunks(text: str) -> list[str]:
    """Split text into TTS-friendly chunks without breaking mid-word when possible."""
    target, hard = _model._chunk_limits()
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= hard:
        return [text]

    sentences = re.split(r"(?<=[.!?؟。])\s+", text)
    chunks: list[str] = []
    current = ""

    def flush():
        nonlocal current
        if current.strip():
            chunks.append(current.strip())
        current = ""

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > hard:
            flush()
            words = sentence.split(" ")
            buf = ""
            for word in words:
                candidate = f"{buf} {word}".strip()
                if len(candidate) > target and buf:
                    chunks.append(buf.strip())
                    buf = word
                else:
                    buf = candidate
            if buf.strip():
                chunks.append(buf.strip())
            continue

        candidate = f"{current} {sentence}".strip() if current else sentence
        if len(candidate) <= target:
            current = candidate
        else:
            flush()
            current = sentence

    flush()
    return chunks or [text[:hard]]


def _concat_wavs(wavs: list[torch.Tensor]) -> torch.Tensor:
    if len(wavs) == 1:
        return wavs[0]
    normalized = []
    for w in wavs:
        if w.dim() == 1:
            w = w.unsqueeze(0)
        normalized.append(w)
    return torch.cat(normalized, dim=-1)


def maybe_cleanup_sessions(force: bool = False) -> None:
    global _last_cleanup
    now = time.time()
    if not force and (now - _last_cleanup) < _SESSION_CLEANUP_INTERVAL:
        return
    _last_cleanup = now

    _, _, sessions_dir = _model._data_dirs()
    if not os.path.isdir(sessions_dir):
        return

    for name in os.listdir(sessions_dir):
        path = os.path.join(sessions_dir, name)
        try:
            if not os.path.isdir(path):
                continue
            if name == "pronunciation-cache":
                from .streaming import _trim_pronunciation_cache
                _trim_pronunciation_cache(path)
                continue
            if now - os.path.getmtime(path) > _SESSION_MAX_AGE_SECONDS:
                for root, dirs, files in os.walk(path, topdown=False):
                    for f in files:
                        os.remove(os.path.join(root, f))
                    for d in dirs:
                        os.rmdir(os.path.join(root, d))
                os.rmdir(path)
                _model._log(f"Cleaned old session: {name}")
                continue
            _reap_stream_chunks(path, now)
        except OSError as e:
            _model._log(f"Session cleanup skipped for {name}: {e}")


def _reap_stream_chunks(session_path: str, now: float) -> None:
    """Delete stale progressive-streaming chunk files in a live session.

    Each chunk is also concatenated into the canonical full-page file, and
    the client switches to that file when the stream completes. The chunk
    files are then pure duplication — roughly doubling session disk use for
    heavy readers. A one-hour grace covers any still-playing stream (active
    generations run minutes, not hours) without racing the player.
    """
    try:
        names = os.listdir(session_path)
    except OSError:
        return
    for name in names:
        if not _CHUNK_FILE_RE.search(name):
            continue
        chunk = os.path.join(session_path, name)
        try:
            if not os.path.isfile(chunk):
                continue
            if now - os.path.getmtime(chunk) <= _CHUNK_GRACE_SECONDS:
                continue
            os.remove(chunk)
        except OSError as exc:
            _model._log(f"Chunk cleanup skipped for {name}: {exc}")


def _synthesize_audio(
    text: str,
    session_id: str,
    filename: str,
    voice_id=None,
    language_id: str = "en",
    cancel_event: GenerationCancellation | None = None,
    generation_settings: dict | None = None,
    leading_silence_s: float = 0.0,
    trailing_silence_s: float = 0.0,
) -> dict:
    """Core TTS synthesis; writes WAV to session dir with the given filename."""
    text = validate_narration_text_length(text)
    session_id = validate_session_id(session_id)
    language_id = validate_language_id(language_id)

    maybe_cleanup_sessions()

    model = _model.get_model(language_id)
    _, voices_dir, sessions_dir = _model._data_dirs()

    audio_prompt_path = None
    if voice_id:
        # Validate the caller-supplied id first so a malformed value
        # raises instead of being silently sanitised to empty/garbage.
        validated_id = validate_voice_id(voice_id)
        safe_id = "".join(c for c in validated_id if c.isalnum() or c in ("-", "_")).strip() or validated_id
        audio_prompt_path = safe_join(voices_dir, f"{safe_id}.wav")
        if not os.path.exists(audio_prompt_path):
            raise FileNotFoundError(f"Voice profile '{safe_id}' not found.")

    generate_kwargs = {}
    if audio_prompt_path:
        generate_kwargs["audio_prompt_path"] = audio_prompt_path

    chunks = _split_into_chunks(text)
    total = len(chunks)
    wav_parts: list[torch.Tensor] = []
    segment_meta: list[dict] = []
    device = getattr(model, "device", _model._resolve_device())
    sr = float(getattr(model, "sr", 24000) or 24000)

    _model._log(
        f"[tts] synthesize file={filename} chars={len(text)} chunks={total} "
        f"device={device} lang={language_id}"
    )

    # Hold ``_generate_lock`` only across the per-chunk inference step
    # rather than across the entire multi-chunk synthesis. The cooperative
    # ``_raise_if_cancelled`` already ensures a newer generation wins, so
    # holding the lock for minutes only blocks conversion/streaming
    # work that could run between chunks.
    _model._model_state["status"] = "generating"
    started_token = _current_generation()
    try:
        cursor_s = 0.0
        for i, chunk in enumerate(chunks):
            # Cooperative cancellation: a newer generation (page change,
            # voice switch, document close) supersedes this synthesis.
            _raise_if_cancelled(cancel_event, started_token)
            _model._model_state["detail"] = (
                f"Generating audio {i + 1}/{total} on {str(device).upper()}"
                + (" (CPU - slow; install CUDA torch for GPU)" if device == "cpu" else "")
            )
            kwargs = dict(generate_kwargs)
            kwargs.update(_generation_kwargs(generation_settings, chunk_index=i))
            if i > 0:
                kwargs.pop("audio_prompt_path", None)
            elif i == 0 and audio_prompt_path:
                kwargs["force_prepare"] = False
            with _generate_lock:
                part = _generate_chunk(model, chunk, language_id, **kwargs)
            if isinstance(part, torch.Tensor):
                part = part.detach().cpu()
            else:
                part = torch.as_tensor(part).cpu()
            if part.dim() == 1:
                part = part.unsqueeze(0)
            samples = int(part.shape[-1])
            dur = samples / sr
            segment_meta.append(
                {
                    "text": chunk,
                    "start_s": round(cursor_s, 4),
                    "end_s": round(cursor_s + dur, 4),
                }
            )
            cursor_s += dur
            wav_parts.append(part)
    except GenerationCancelled:
        # Cancellation is not a failure: restore ready state and propagate.
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

    wav = _concat_wavs(wav_parts)
    if generation_settings:
        pace = float(generation_settings.get("pace", 1.0))
        if abs(pace - 1.0) >= PACE_TOLERANCE:
            original_samples = int(wav.shape[-1])
            _raise_if_cancelled(cancel_event, started_token)
            wav = _apply_pace(
                wav,
                pace,
                int(sr),
                cancel_check=lambda: (
                    (cancel_event is not None and cancel_event.cancelled())
                    or _current_generation() != started_token
                ),
            )
            _raise_if_cancelled(cancel_event, started_token)
            timing_scale = (
                float(wav.shape[-1]) / float(original_samples)
                if original_samples > 0
                else 1.0
            )
            for segment in segment_meta:
                segment["start_s"] = round(float(segment["start_s"]) * timing_scale, 4)
                segment["end_s"] = round(float(segment["end_s"]) * timing_scale, 4)
    leading_samples = max(0, int(round(float(leading_silence_s) * sr)))
    trailing_samples = max(0, int(round(float(trailing_silence_s) * sr)))
    if leading_samples or trailing_samples:
        silence_shape = (*wav.shape[:-1],)
        pieces = []
        if leading_samples:
            pieces.append(torch.zeros(*silence_shape, leading_samples, dtype=wav.dtype, device=wav.device))
        pieces.append(wav)
        if trailing_samples:
            pieces.append(torch.zeros(*silence_shape, trailing_samples, dtype=wav.dtype, device=wav.device))
        wav = torch.cat(pieces, dim=-1)
        if leading_samples:
            offset_s = leading_samples / sr
            for segment in segment_meta:
                segment["start_s"] = round(float(segment["start_s"]) + offset_s, 4)
                segment["end_s"] = round(float(segment["end_s"]) + offset_s, 4)

    output_dir = safe_join(sessions_dir, session_id)
    # ``mkdir`` is robust to the directory already existing and avoids
    # relying on the caller having created ``sessions_dir`` first.
    os.makedirs(output_dir, exist_ok=True)
    output_path = safe_join(output_dir, filename)

    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    # Write to a temp file in the same directory so the final ``os.replace``
    # is on the same filesystem and atomic. A crash mid-write leaves the
    # existing target untouched instead of producing a half-written WAV.
    # ``exist_ok=True`` mirrors the production layout for tests that mock
    # ``os.makedirs`` away.
    try:
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{Path(output_path).stem}-", suffix=".wav.tmp", dir=output_dir
        )
    except FileNotFoundError:
        os.makedirs(output_dir, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{Path(output_path).stem}-", suffix=".wav.tmp", dir=output_dir
        )
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        ta.save(str(temp_path), wav, model.sr)
        from services.storage_utils import replace_file_with_retry
        replace_file_with_retry(temp_path, Path(output_path))
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise

    result = {
        "audio_url": f"/sessions/{session_id}/{filename}",
        "segments": segment_meta,
        "duration_s": round(float(wav.shape[-1]) / sr, 4),
    }

    # Forced alignment (CTC, with Whisper fallback) for accurate word
    # timestamps. Chunk boundaries let the aligner work per sentence so
    # timing error cannot accumulate across chunks.
    try:
        from services.alignment_service import align_words

        word_timings = align_words(text, output_path, language_id, segments=segment_meta)
        if word_timings:
            result["word_timings"] = word_timings
    except Exception as exc:  # noqa: BLE001 - alignment is optional; timing falls back
        _model._log(f"Forced alignment skipped, falling back to estimates: {exc}")

    return result


def narrate_text(
    text,
    session_id,
    page_index,
    voice_id=None,
    language_id="en",
    clip_suffix: str | None = None,
    cancel_event: GenerationCancellation | None = None,
):
    session_id = validate_session_id(session_id)
    page_index = validate_page_index(page_index)
    language_id = validate_language_id(language_id)
    filename = _audio_filename(
        page_index,
        text,
        voice_id,
        language_id,
        clip_suffix,
    )

    return _synthesize_audio(text, session_id, filename, voice_id, language_id, cancel_event)


def _audio_filename(
    page_index: int,
    text: str,
    voice_id: str | None,
    language_id: str,
    clip_suffix: str | None,
    generation_settings: dict | None = None,
) -> str:
    """Return an immutable filename for one narration input revision.

    The voice reference checksum and the model/app versions are always part
    of the identity: re-recording a voice prompt or upgrading the engine
    must never silently serve audio rendered under different conditions.
    """
    identity_parts = [
        str(page_index),
        text,
        voice_id or "default",
        language_id,
        str(clip_suffix or ""),
        _model._voice_reference_checksum(voice_id),
        _model._chatterbox_model_version(),
        config_service.app_version(),
    ]
    if generation_settings is not None:
        identity_parts.extend(
            [
                json.dumps(generation_settings, sort_keys=True, separators=(",", ":")),
                STUDIO_GENERATION_PIPELINE_VERSION,
            ]
        )
    identity = "\0".join(identity_parts)
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    partial = ""
    if clip_suffix:
        safe_suffix = re.sub(r"[^a-zA-Z0-9_-]", "", str(clip_suffix))[:24]
        if safe_suffix:
            partial = f"_p{safe_suffix}"
    return f"page_{page_index}{partial}_{digest}.wav"
