"""Audio repair: splice a TTS-rendered replacement into an existing recording."""
from __future__ import annotations

import copy
import math
import os
import re
import struct
import time
import uuid
import wave
from pathlib import Path

from services.path_utils import (
    validate_language_id,
    validate_narration_text_length,
    validate_voice_id,
)

from . import manifest as _manifest
from . import media as _media
from .voice_profiles import _EventCancellation


def _asset_record(manifest: dict, asset_id: str) -> tuple[dict, str]:
    if not _manifest.PROJECT_ID_RE.fullmatch(str(asset_id or "")):
        raise ValueError("Invalid Studio asset id.")
    for source in manifest.get("sources") or []:
        if source.get("id") == asset_id:
            return source, "SOURCE"
    for output in manifest.get("outputs") or []:
        if output.get("id") == asset_id:
            return output, "OUTPUT"
    raise FileNotFoundError("Studio asset was not found.")


def _fit_replacement(replacement, target_frames: int, sample_rate: int):
    import numpy as np

    audio = np.asarray(replacement, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio[:, None]
    if len(audio) < 2 or target_frames < 2:
        raise ValueError("Repair selection is too short.")
    rate = len(audio) / float(target_frames)
    if not 0.75 <= rate <= 1.25:
        raise ValueError(
            "The replacement differs too much from the selected duration. Adjust the selection or wording."
        )
    if abs(rate - 1.0) > 0.001:
        import torch
        import torchaudio as ta

        n_fft = 1024
        hop_length = 256
        window = torch.hann_window(n_fft)
        stretched = []
        for channel in range(audio.shape[1]):
            samples = torch.from_numpy(audio[:, channel])
            spectrum = torch.stft(
                samples,
                n_fft=n_fft,
                hop_length=hop_length,
                window=window,
                return_complex=True,
            )
            phase_advance = torch.linspace(
                0, math.pi * hop_length, spectrum.shape[-2]
            )[..., None]
            changed = ta.functional.phase_vocoder(spectrum, rate=rate, phase_advance=phase_advance)
            restored = torch.istft(
                changed,
                n_fft=n_fft,
                hop_length=hop_length,
                window=window,
                length=target_frames,
            )
            stretched.append(restored.numpy())
        audio = np.stack(stretched, axis=1)
    if len(audio) > target_frames:
        audio = audio[:target_frames]
    elif len(audio) < target_frames:
        audio = np.pad(audio, ((0, target_frames - len(audio)), (0, 0)))
    return audio.astype(np.float32, copy=False)


def _resample_and_match_channels(replacement, replacement_rate: int, sample_rate: int, channels: int):
    import numpy as np

    audio = np.asarray(replacement, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio[:, None]
    if replacement_rate != sample_rate:
        import torch
        import torchaudio as ta

        converted = ta.functional.resample(
            torch.from_numpy(audio.T), replacement_rate, sample_rate
        )
        audio = converted.numpy().T
    if audio.shape[1] != channels:
        mono = audio.mean(axis=1, keepdims=True)
        audio = np.repeat(mono, channels, axis=1)
    return audio


def _splice_replacement(source, replacement, start_frame: int, end_frame: int, sample_rate: int):
    import numpy as np

    result = np.asarray(source, dtype=np.float32).copy()
    original = result[start_frame:end_frame]
    patch = np.asarray(replacement, dtype=np.float32).copy()
    target_rms = float(np.sqrt(np.mean(original * original))) if original.size else 0.0
    patch_rms = float(np.sqrt(np.mean(patch * patch))) if patch.size else 0.0
    if target_rms > 0.0001 and patch_rms > 0.0001:
        patch *= max(0.25, min(4.0, target_rms / patch_rms))
    patch = np.clip(patch, -0.99, 0.99)
    fade = min(int(sample_rate * 0.03), len(patch) // 3)
    if fade > 1:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)[:, None]
        patch[:fade] = original[:fade] * (1.0 - ramp) + patch[:fade] * ramp
        patch[-fade:] = patch[-fade:] * (1.0 - ramp) + original[-fade:] * ramp
    result[start_frame:end_frame] = patch
    return result


def _read_wav_audio(path: Path):
    import numpy as np

    fmt = None
    data = None
    with Path(path).open("rb") as handle:
        header = handle.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise ValueError("Studio audio is not a valid WAV file.")
        while True:
            chunk_header = handle.read(8)
            if len(chunk_header) < 8:
                break
            chunk_id, chunk_size = struct.unpack("<4sI", chunk_header)
            payload = handle.read(chunk_size)
            if chunk_size & 1:
                handle.read(1)
            if chunk_id == b"fmt ":
                fmt = payload
            elif chunk_id == b"data":
                data = payload
    if fmt is None or data is None or len(fmt) < 16:
        raise ValueError("Studio audio is missing WAV format data.")
    audio_format, channels, sample_rate, _, block_align, bits = struct.unpack_from("<HHIIHH", fmt)
    if audio_format == 0xFFFE and len(fmt) >= 26:
        audio_format = struct.unpack_from("<H", fmt, 24)[0]
    if channels < 1 or block_align < 1:
        raise ValueError("Studio WAV channel metadata is invalid.")
    if audio_format == 3 and bits == 32:
        samples = np.frombuffer(data, dtype="<f4").astype(np.float32, copy=False)
    elif audio_format == 3 and bits == 64:
        samples = np.frombuffer(data, dtype="<f8").astype(np.float32)
    elif audio_format == 1 and bits == 16:
        samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    elif audio_format == 1 and bits == 32:
        samples = np.frombuffer(data, dtype="<i4").astype(np.float32) / 2147483648.0
    elif audio_format == 1 and bits == 8:
        samples = (np.frombuffer(data, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"Unsupported Studio WAV encoding ({audio_format}, {bits}-bit).")
    frame_count = len(samples) // channels
    return samples[: frame_count * channels].reshape(frame_count, channels), sample_rate


def _write_wav_pcm16(path: Path, audio, sample_rate: int) -> None:
    import numpy as np

    samples = np.asarray(audio, dtype=np.float32)
    if samples.ndim == 1:
        samples = samples[:, None]
    encoded = (np.clip(samples, -1.0, 0.999969) * 32768.0).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(samples.shape[1])
        output.setsampwidth(2)
        output.setframerate(int(sample_rate))
        output.writeframes(encoded.tobytes())


def _session_audio_path(session_id: str, audio_url: str) -> Path:
    prefix = f"/sessions/{session_id}/"
    if not str(audio_url or "").startswith(prefix):
        raise RuntimeError("Generated Studio audio path is invalid.")
    filename = str(audio_url)[len(prefix):]
    if not filename or Path(filename).name != filename:
        raise RuntimeError("Generated Studio audio path is invalid.")
    path = Path(os.environ.get("DATA_DIR", "data")) / "sessions" / session_id / filename
    if not path.is_file():
        raise FileNotFoundError("Generated Studio audio was not found.")
    return path


def create_repair(
    project_id: str,
    asset_id: str,
    start_sec: float,
    end_sec: float,
    replacement_text: str,
    language_id: str,
    voice_id: str | None,
    generation_settings: dict,
    *,
    cancel_event=None,
) -> dict:
    from .narration import validate_generation_settings
    safe_id = _manifest._validate_project_id(project_id)
    text = validate_narration_text_length(replacement_text)
    language = validate_language_id(language_id)
    voice = validate_voice_id(voice_id) if voice_id else None
    settings = validate_generation_settings(generation_settings)
    with _manifest._project_lock(safe_id):
        manifest = _manifest._load_manifest(safe_id, normalize_jobs=False)
        asset, asset_kind = _asset_record(manifest, asset_id)
        asset = copy.deepcopy(asset)
    try:
        start = float(start_sec)
        end = float(end_sec)
    except (TypeError, ValueError) as exc:
        raise ValueError("Repair times must be numbers.") from exc
    if start < 0 or end - start < 0.25 or end - start > 20:
        raise ValueError("Select a repair range between 0.25 and 20 seconds.")
    duration = float(asset.get("durationSec") or 0)
    if duration and end > duration + 0.01:
        raise ValueError("Repair selection extends beyond the source audio.")

    from services import generation_gateway

    session_id = f"studio-{safe_id}"
    cancellation = _EventCancellation(cancel_event)
    generated = generation_gateway.narrate_repair(
        session_id, text, language, voice, settings, cancellation=cancellation
    )
    if cancellation.cancelled():
        raise RuntimeError("Studio repair was cancelled.")
    replacement_path = _session_audio_path(session_id, generated.get("audio_url"))

    root = _manifest.project_dir(safe_id)
    relative = asset.get("audioPath") if asset_kind == "SOURCE" else asset.get("path")
    master = (root / str(relative or "")).resolve()
    if root.resolve() not in master.parents or not master.is_file():
        raise FileNotFoundError("Studio repair source was not found.")
    source_audio, sample_rate = _read_wav_audio(master)
    replacement, replacement_rate = _read_wav_audio(replacement_path)
    replacement = _resample_and_match_channels(
        replacement, replacement_rate, sample_rate, source_audio.shape[1]
    )
    start_frame = max(0, int(round(start * sample_rate)))
    end_frame = min(len(source_audio), int(round(end * sample_rate)))
    replacement = _fit_replacement(replacement, end_frame - start_frame, sample_rate)
    repaired = _splice_replacement(
        source_audio, replacement, start_frame, end_frame, sample_rate
    )

    output_id = uuid.uuid4().hex
    target = root / "outputs" / f"{output_id}.wav"
    temp = target.with_suffix(".wav.tmp")
    try:
        _write_wav_pcm16(temp, repaired, sample_rate)
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    repair_id = uuid.uuid4().hex
    from .media import _sha256_file
    output = {
        "id": output_id,
        "kind": "REPAIR_AUDIO",
        "fileName": f"repaired-{output_id[:8]}.wav",
        "format": "WAV",
        "parentAssetId": asset_id,
        "repairId": repair_id,
        "durationSec": round(len(repaired) / float(sample_rate), 4),
        "sampleRate": sample_rate,
        "channels": int(repaired.shape[1]),
        "sizeBytes": target.stat().st_size,
        "sha256": _sha256_file(target),
        "path": str(target.relative_to(root)).replace("\\", "/"),
        "createdAt": time.time(),
    }
    repair = {
        "id": repair_id,
        "assetId": asset_id,
        "sourceKind": asset_kind,
        "startSec": round(start, 4),
        "endSec": round(end, 4),
        "replacementText": text,
        "languageId": language,
        "voiceId": voice,
        "generationSettings": settings,
        "outputId": output_id,
        "status": "PREVIEW_READY",
        "createdAt": time.time(),
    }
    with _manifest._project_lock(safe_id):
        manifest = _manifest._load_manifest(safe_id, normalize_jobs=False)
        manifest.setdefault("repairs", []).append(repair)
        manifest.setdefault("outputs", []).append(output)
        manifest["updatedAt"] = time.time()
        _manifest._write_json_atomic(_manifest._manifest_path(safe_id), manifest)
        public = _manifest._public_project(manifest)
        return {"repair": public["repairs"][-1], "output": public["outputs"][-1]}


def export_repair_video(project_id: str, repair_id: str) -> dict:
    safe_id = _manifest._validate_project_id(project_id)
    if not _manifest.PROJECT_ID_RE.fullmatch(str(repair_id or "")):
        raise ValueError("Invalid Studio repair id.")
    with _manifest._project_lock(safe_id):
        manifest = _manifest._load_manifest(safe_id, normalize_jobs=False)
        repair = next(
            (item for item in manifest.get("repairs") or [] if item.get("id") == repair_id),
            None,
        )
        if repair is None:
            raise FileNotFoundError("Studio repair was not found.")
        source, source_kind = _asset_record(manifest, repair.get("assetId"))
        if source_kind != "SOURCE" or source.get("mediaType") != "VIDEO":
            raise ValueError("This repair does not have a video source.")
        repaired_audio, output_kind = _asset_record(manifest, repair.get("outputId"))
        if output_kind != "OUTPUT" or repaired_audio.get("kind") != "REPAIR_AUDIO":
            raise FileNotFoundError("Repaired audio was not found.")
        source = copy.deepcopy(source)
        repaired_audio = copy.deepcopy(repaired_audio)

    from .media import _sha256_file
    root = _manifest.project_dir(safe_id)
    video_path = (root / str(source.get("path") or "")).resolve()
    audio_path = (root / str(repaired_audio.get("path") or "")).resolve()
    if root.resolve() not in video_path.parents or not video_path.is_file():
        raise FileNotFoundError("Studio video source was not found.")
    if root.resolve() not in audio_path.parents or not audio_path.is_file():
        raise FileNotFoundError("Repaired audio was not found.")

    output_id = uuid.uuid4().hex
    target = root / "outputs" / f"{output_id}.mp4"
    temp = target.with_suffix(".mp4.tmp")
    common = [
        "-y", "-v", "error", "-i", str(video_path), "-i", str(audio_path),
        "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", "-shortest",
    ]
    try:
        try:
            _media._run_media_tool(
                "ffmpeg", [*common, "-c:v", "copy", "-f", "mp4", str(temp)], timeout=900
            )
        except ValueError:
            temp.unlink(missing_ok=True)
            _media._run_media_tool(
                "ffmpeg",
                [
                    *common,
                    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-f", "mp4", str(temp),
                ],
                timeout=1800,
            )
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    output = {
        "id": output_id,
        "kind": "REPAIR_VIDEO",
        "fileName": f"repaired-{Path(source.get('fileName') or 'video').stem}.mp4",
        "format": "MP4",
        "parentAssetId": source["id"],
        "repairId": repair_id,
        "durationSec": float(repaired_audio.get("durationSec") or source.get("durationSec") or 0),
        "sizeBytes": target.stat().st_size,
        "sha256": _sha256_file(target),
        "path": str(target.relative_to(root)).replace("\\", "/"),
        "createdAt": time.time(),
    }
    with _manifest._project_lock(safe_id):
        manifest = _manifest._load_manifest(safe_id, normalize_jobs=False)
        repair = next(item for item in manifest["repairs"] if item.get("id") == repair_id)
        repair["status"] = "EXPORTED"
        repair["videoOutputId"] = output_id
        manifest.setdefault("outputs", []).append(output)
        manifest["updatedAt"] = time.time()
        _manifest._write_json_atomic(_manifest._manifest_path(safe_id), manifest)
        return _manifest._public_project(manifest)["outputs"][-1]
