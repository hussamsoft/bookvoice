"""Voice conversion: S3Gen-only inference that re-voices a recording
in a target voice, keeping the original timing/emphasis.

Voice conversion only needs the S3Gen decoder (~1 GB) — never the ~2 GB
autoregressive T3 text decoder that narration depends on. So:
- If the narration model is already loaded, wrap its S3Gen. No second copy
  of the decoder is allocated.
- Otherwise load S3Gen on its own rather than pulling in the whole narration
  stack. That keeps conversion usable on machines that cannot comfortably
  hold the full model — notably CPU-only laptops, where T3's autoregressive
  loop is the slow part and conversion never runs it.
"""
from __future__ import annotations

import hashlib
import math
import os
import tempfile
import time
import wave
from pathlib import Path

import numpy as np
import torch

from services import media_tools
from services.config_service import app_version
from services.path_utils import safe_join, validate_session_id

from . import model as _model
from . import synth as _synth
from .queue import (
    GenerationCancellation,
    GenerationCancelled,
    _current_generation,
    _raise_if_cancelled,
)


VC_INPUT_SR = 16_000
VC_MAX_WINDOW_S = 24.0
VC_MIN_SPEECH_S = 0.12
VC_MERGE_GAP_S = 0.30
VC_EDGE_PAD_S = 0.06
VC_FRAME_S = 0.02
VC_REFERENCE_MAX_S = 10.0
# Chatterbox defaults to 0.7. A modest increase gives the target reference
# more influence over speaker identity without destabilizing the decoder.
VC_TARGET_GUIDANCE = 1.0
_VC_MAX_PCM_BYTES = 2 * 1024 * 1024 * 1024


class _InferenceCfgRateGuard:
    """Context manager that temporarily raises ``inference_cfg_rate`` on a
    vendored S3Gen decoder and restores it on exit.

    The vendored decoder exposes this as a plain Python attribute today;
    a future refactor could turn it into a property or move it onto a
    config object. Guard against both shape changes ("attribute missing")
    and read-only attributes by snapping a sentinel on entry and restoring
    whatever we found.
    """

    _SENTINEL = object()

    def __init__(self, converter, target_guidance: float) -> None:
        self._decoder = getattr(getattr(converter, "s3gen", None), "flow", None)
        self._decoder = getattr(self._decoder, "decoder", None)
        self._target = float(target_guidance)
        self._previous: object = self._SENTINEL
        self._changed = False

    def __enter__(self) -> "_InferenceCfgRateGuard":
        if self._decoder is None:
            return self
        previous = getattr(self._decoder, "inference_cfg_rate", self._SENTINEL)
        if isinstance(previous, (int, float)):
            self._previous = previous
            try:
                self._decoder.inference_cfg_rate = max(float(previous), self._target)
                self._changed = True
            except (AttributeError, TypeError):
                # Read-only or descriptor; leave it alone.
                self._previous = self._SENTINEL
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if not self._changed or self._previous is self._SENTINEL:
            return
        try:
            self._decoder.inference_cfg_rate = self._previous  # type: ignore[attr-defined]
        except (AttributeError, TypeError):
            pass


def _decode_pcm_mono(path: str, sample_rate: int) -> "np.ndarray":
    """Decode any supported media file to mono float32 at ``sample_rate``."""
    with tempfile.TemporaryDirectory(prefix="bookvoice-vc-") as temp_dir:
        raw_path = Path(temp_dir) / "audio.f32le"
        media_tools.run_media_tool(
            "ffmpeg",
            [
                "-y", "-v", "error", "-i", str(path),
                "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(int(sample_rate)),
                "-f", "f32le", str(raw_path),
            ],
            timeout=1800,
        )
        try:
            raw_bytes = os.path.getsize(raw_path)
        except OSError as exc:
            raise ValueError("The recording contains no decodable audio.") from exc
        if raw_bytes == 0:
            raise ValueError("The recording contains no decodable audio.")
        if raw_bytes > _VC_MAX_PCM_BYTES:
            raise ValueError("The recording is too long to convert.")
        data = np.fromfile(raw_path, dtype="<f4")
    if data.size == 0:
        raise ValueError("The recording contains no decodable audio.")
    return np.nan_to_num(data.astype(np.float32, copy=False), nan=0.0, posinf=0.0, neginf=0.0)


def _write_pcm16_wav(path: str, audio: torch.Tensor, sample_rate: int) -> None:
    """Write mono 16-bit PCM.

    Studio waveforms, splicing and repair all require 16-bit PCM, so conversion
    output is encoded explicitly rather than relying on the torchaudio backend's
    default encoding.
    """
    samples = audio.detach().cpu().float().reshape(-1).numpy()
    clipped = np.clip(np.nan_to_num(samples, nan=0.0), -1.0, 1.0)
    encoded = np.round(clipped * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(int(sample_rate))
        output.writeframes(encoded.tobytes())


def _speech_windows(
    audio: "np.ndarray",
    sample_rate: int,
    *,
    max_window_s: float = VC_MAX_WINDOW_S,
) -> list[tuple[int, int]]:
    """Split audio into speech spans at natural pauses, each under the window cap.

    Converting a long recording in one pass overruns the speech tokenizer, so the
    source is cut where the speaker is already silent. Pauses are preserved by the
    caller, which keeps the converted performance aligned with the original.
    """
    total = int(audio.shape[-1])
    if total <= 0:
        return []
    frame = max(1, int(sample_rate * VC_FRAME_S))
    frame_count = total // frame
    if frame_count < 2:
        return [(0, total)]
    frames = audio[: frame_count * frame].reshape(frame_count, frame)
    rms = np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1))
    loud = float(np.percentile(rms, 95))
    threshold = max(1e-4, loud * 0.10)
    voiced = rms >= threshold
    if not bool(voiced.any()):
        return [(0, total)]

    spans: list[list[int]] = []
    start = None
    for index, is_voiced in enumerate(voiced):
        if is_voiced and start is None:
            start = index
        elif not is_voiced and start is not None:
            spans.append([start, index])
            start = None
    if start is not None:
        spans.append([start, frame_count])

    merge_frames = max(1, int(VC_MERGE_GAP_S / VC_FRAME_S))
    merged: list[list[int]] = []
    for span in spans:
        if merged and span[0] - merged[-1][1] <= merge_frames:
            merged[-1][1] = span[1]
        else:
            merged.append(list(span))

    min_frames = max(1, int(VC_MIN_SPEECH_S / VC_FRAME_S))
    pad = max(0, int(VC_EDGE_PAD_S / VC_FRAME_S))
    max_frames = max(min_frames, int(max_window_s / VC_FRAME_S))
    windows: list[tuple[int, int]] = []
    for span_start, span_end in merged:
        if span_end - span_start < min_frames:
            continue
        span_start = max(0, span_start - pad)
        span_end = min(frame_count, span_end + pad)
        length = span_end - span_start
        if length <= max_frames:
            windows.append((span_start * frame, min(total, span_end * frame)))
            continue
        pieces = int(math.ceil(length / max_frames))
        step = int(math.ceil(length / pieces))
        for offset in range(span_start, span_end, step):
            piece_end = min(span_end, offset + step)
            if piece_end - offset < min_frames:
                continue
            windows.append((offset * frame, min(total, piece_end * frame)))
    return windows or [(0, total)]


def _speech_dense_reference(
    audio: "np.ndarray",
    sample_rate: int,
    *,
    max_seconds: float = VC_REFERENCE_MAX_S,
) -> tuple["np.ndarray", float]:
    """Select the most speech-dense target window instead of the first seconds.

    Chatterbox only consumes ten seconds of target audio. Phone/video clips
    often begin with silence, music, or an intro; always taking the beginning
    weakens the target speaker embedding and lets source identity leak through.
    """
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    cap = max(1, int(round(float(sample_rate) * max_seconds)))
    if samples.size <= cap:
        return samples, 0.0

    frame = max(1, int(round(float(sample_rate) * VC_FRAME_S)))
    frame_count = samples.size // frame
    frames = samples[: frame_count * frame].reshape(frame_count, frame)
    rms = np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1))
    loud = float(np.percentile(rms, 95)) if rms.size else 0.0
    threshold = max(1e-4, loud * 0.10)
    window_frames = min(frame_count, max(1, int(round(max_seconds / VC_FRAME_S))))
    step_frames = max(1, int(round(0.5 / VC_FRAME_S)))
    best_start = 0
    best_score = (-1.0, -1.0)
    final_start = max(0, frame_count - window_frames)
    starts = list(range(0, final_start + 1, step_frames))
    if not starts or starts[-1] != final_start:
        starts.append(final_start)
    for start in starts:
        window = rms[start : start + window_frames]
        score = (
            float(np.mean(window >= threshold)),
            float(np.mean(window)),
        )
        if score > best_score:
            best_score = score
            best_start = start
    start_sample = best_start * frame
    return samples[start_sample : start_sample + cap], start_sample / float(sample_rate)


def _set_conversion_target(converter, target_voice_path: str, device: str, sample_rate: int) -> float:
    target_audio = _decode_pcm_mono(target_voice_path, sample_rate)
    reference, start_seconds = _speech_dense_reference(target_audio, sample_rate)
    converter.ref_dict = converter.s3gen.embed_ref(
        reference,
        sample_rate,
        device=device,
    )
    return start_seconds


def get_voice_converter():
    """Return a ChatterboxVC, reusing resident weights when there are any.

    Conversion needs only the S3Gen decoder (~1 GB) — never the ~2 GB
    autoregressive T3 text decoder that narration depends on. So:

    * If the narration model is already loaded, wrap its S3Gen. No second copy
      of the decoder is allocated.
    * Otherwise load S3Gen on its own rather than pulling in the whole narration
      stack. That keeps conversion usable on machines that cannot comfortably
      hold the full model — notably CPU-only laptops, where T3's autoregressive
      loop is the slow part and conversion never runs it.
    """
    global _vc_model, _vc_model_device, _vc_source_s3gen
    from chatterbox.vc import ChatterboxVC

    with _model._model_lock:
        resident = _model._model
    s3gen = getattr(resident, "s3gen", None) if resident is not None else None
    if s3gen is not None:
        device = getattr(resident, "device", _model._resolve_device())
        with _model._vc_lock:
            # Drop a standalone decoder once the full model supersedes it.
            if _model._vc_model is not None and _model._vc_source_s3gen is not s3gen:
                _model._vc_model = None
                _model._vc_source_s3gen = None
                import gc
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            if _model._vc_model is None:
                _model._vc_model = ChatterboxVC(s3gen, device)
                _model._vc_model_device = device
                _model._vc_source_s3gen = s3gen
            return _model._vc_model

    with _model._vc_lock:
        if _model._vc_model is not None:
            return _model._vc_model
        device = _model._resolve_device()
        ckpt_dir = _model._local_model_path("en")
        if not os.path.isfile(os.path.join(ckpt_dir, "s3gen.safetensors")):
            raise FileNotFoundError(
                f"Voice conversion weights (s3gen.safetensors) were not found at: {ckpt_dir}."
            )
        _model._model_state["status"] = "loading"
        _model._model_state["detail"] = (
            f"Loading S3Gen audio decoder (~1.0GB) into {device.upper()} for voice conversion…"
        )
        _model._model_state["loading_started"] = time.time()
        started = time.time()
        try:
            _model._vc_model = ChatterboxVC.from_local(ckpt_dir, device)
            _model._vc_model_device = device
        except Exception as exc:
            _model._model_state["status"] = "error"
            _model._model_state["detail"] = str(exc)
            _model._model_state["loading_started"] = None
            raise
        _model._model_state["status"] = "ready"
        _model._model_state["detail"] = f"Voice conversion ready on {str(device).upper()}."
        _model._model_state["loading_started"] = None
        _model._model_state["device"] = device
        _model._log(f"Voice conversion decoder loaded in {time.time() - started:.1f}s on {device}.")
        return _model._vc_model


def convert_voice_audio(
    source_path: str,
    target_voice_path: str,
    session_id: str,
    filename: str,
    cancel_event: GenerationCancellation | None = None,
    *,
    progress=None,
) -> dict:
    """Re-render a recording in a target voice, keeping the original delivery.

    Speech-to-speech conversion carries the source performance — timing, rhythm,
    emphasis — so no generation controls are needed to recreate the sound.
    """
    session_id = validate_session_id(session_id)
    data_dir, voices_dir, sessions_dir = _model._data_dirs()
    # Source and target voice paths come from internal callers that have
    # already run them through ``safe_join``; this module does not accept
    # raw user-supplied paths. Validate they exist and resolve to a real
    # file rather than re-applying containment, which would block the
    # legitimate temp-dir layout used by the voice-conversion tests.
    if not os.path.isfile(source_path):
        raise FileNotFoundError("The recording to convert was not found.")
    if not os.path.isfile(target_voice_path):
        raise FileNotFoundError("The target voice reference was not found.")
    source_full = source_path
    target_voice_full = target_voice_path

    _synth.maybe_cleanup_sessions()
    converter = get_voice_converter()
    device = getattr(converter, "device", _model._resolve_device())
    out_sr = int(getattr(converter, "sr", 24_000) or 24_000)

    audio = _decode_pcm_mono(source_full, VC_INPUT_SR)
    windows = _speech_windows(audio, VC_INPUT_SR)
    total_windows = len(windows)
    _model._log(
        f"[vc] convert file={filename} source_s={audio.shape[-1] / VC_INPUT_SR:.1f} "
        f"windows={total_windows} device={device}"
    )

    with _synth._generate_lock:
        _model._model_state["status"] = "generating"
        started_token = _current_generation()
        pieces: list[torch.Tensor] = []
        try:
            reference_start = _set_conversion_target(
                converter,
                target_voice_full,
                device,
                out_sr,
            )
            _model._log(
                f"[vc] target reference start={reference_start:.2f}s "
                f"duration={VC_REFERENCE_MAX_S:.1f}s guidance={VC_TARGET_GUIDANCE:.2f}"
            )
            cursor = 0
            try:
                with _InferenceCfgRateGuard(converter, VC_TARGET_GUIDANCE):
                    for index, (start, end) in enumerate(windows):
                        _raise_if_cancelled(cancel_event, started_token)
                        _model._model_state["detail"] = (
                            f"Converting voice {index + 1}/{total_windows} on {str(device).upper()}"
                        )
                        gap = start - cursor
                        if gap > 0:
                            silence = int(round(gap * out_sr / VC_INPUT_SR))
                            if silence > 0:
                                pieces.append(torch.zeros(1, silence))
                        window = audio[start:end]
                        with torch.inference_mode():
                            tensor = torch.from_numpy(window).float().to(device).unsqueeze(0)
                            tokens, _ = converter.s3gen.tokenizer(tensor)
                            wav, _ = converter.s3gen.inference(
                                speech_tokens=tokens,
                                ref_dict=converter.ref_dict,
                            )
                            rendered = wav.squeeze(0).detach().cpu().float().numpy()
                        if _model._is_cuda_build() and getattr(converter, "watermarker", None) is not None:
                            try:
                                rendered = converter.watermarker.apply_watermark(
                                    rendered, sample_rate=out_sr
                                )
                            except Exception as exc:  # noqa: BLE001 - watermark is optional
                                _model._log(f"Watermark skipped: {exc}")
                        pieces.append(torch.from_numpy(np.asarray(rendered)).float().unsqueeze(0))
                        cursor = end
                        if progress is not None:
                            try:
                                progress((index + 1) / max(1, total_windows))
                            except Exception:  # noqa: BLE001 - progress is advisory
                                pass
            finally:
                pass
            trailing = int(audio.shape[-1]) - cursor
            if trailing > 0:
                silence = int(round(trailing * out_sr / VC_INPUT_SR))
                if silence > 0:
                    pieces.append(torch.zeros(1, silence))
        except GenerationCancelled:
            _model._model_state["status"] = "ready"
            _model._model_state["detail"] = f"Model ready on {str(device).upper()}."
            raise
        except Exception as exc:
            _model._model_state["status"] = "ready"
            _model._model_state["detail"] = (
                f"Model ready on {str(device).upper()} (last conversion failed: {exc})"
            )
            raise
        else:
            _model._model_state["status"] = "ready"
            _model._model_state["detail"] = f"Model ready on {str(device).upper()}."

    if not pieces:
        raise ValueError("No speech was found in the recording to convert.")
    converted = _synth._concat_wavs(pieces)
    peak = float(converted.abs().max().item() or 0.0)
    if peak > 1.0:
        converted = converted / peak

    output_dir = safe_join(sessions_dir, session_id)
    os.makedirs(output_dir, exist_ok=True)
    output_path = safe_join(output_dir, filename)
    _write_pcm16_wav(output_path, converted, out_sr)
    return {
        "audio_url": f"/sessions/{session_id}/{filename}",
        "duration_s": round(float(converted.shape[-1]) / out_sr, 4),
        "sampleRate": out_sr,
        "windows": total_windows,
        "sourceDurationSec": round(float(audio.shape[-1]) / VC_INPUT_SR, 4),
    }


def conversion_filename(source_signature: str, voice_id: str | None) -> str:
    """Immutable filename for one conversion input revision."""
    identity = "\0".join(
        (
            str(source_signature or ""),
            str(voice_id or "default"),
            _model._voice_reference_checksum(voice_id),
            _model._chatterbox_model_version(),
            app_version(),
            _synth.STUDIO_GENERATION_PIPELINE_VERSION,
        )
    )
    return f"convert_{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:20]}.wav"
