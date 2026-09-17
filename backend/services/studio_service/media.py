"""Media inspection, audio extraction, video preview, waveform peaks,
file import, and shared hashing helpers.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import struct
import tempfile
import time
import uuid
import wave
from pathlib import Path

from services import media_tools

from . import manifest as _manifest


MEDIA_EXTENSIONS = {
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".webm",
    ".mp4", ".mov", ".mkv",
}


def _media_tool_path(name: str) -> str:
    return media_tools.media_tool_path(name)


def _redact_media_error(message: str) -> str:
    return media_tools.redact_media_error(message)


def _run_media_tool(name: str, args: list[str], timeout: int = 300) -> str:
    return media_tools.run_media_tool(name, args, timeout)


def _probe_media(path: Path) -> dict:
    raw = _run_media_tool(
        "ffprobe",
        [
            "-v", "error", "-show_entries",
            "format=duration,format_name:stream=codec_type,sample_rate,channels",
            "-of", "json", str(path),
        ],
        timeout=60,
    )
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("Media metadata could not be read.") from exc
    streams = payload.get("streams") if isinstance(payload, dict) else None
    streams = streams if isinstance(streams, list) else []
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if not audio:
        raise ValueError("Uploaded media does not contain an audio stream.")
    try:
        duration = float((payload.get("format") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0
    if duration <= 0:
        raise ValueError("Uploaded media has no measurable duration.")
    if duration > _manifest.MAX_SOURCE_DURATION_SEC:
        raise ValueError("Studio media may not exceed six hours.")
    return {
        "durationSec": round(duration, 4),
        "hasVideo": any(stream.get("codec_type") == "video" for stream in streams),
        "sampleRate": int(audio.get("sample_rate") or 24_000),
        "channels": max(1, min(2, int(audio.get("channels") or 1))),
        "formatName": str((payload.get("format") or {}).get("format_name") or "unknown"),
    }


def _extract_edit_audio(source: Path, target: Path, *, sample_rate: int, channels: int) -> None:
    temp = target.with_suffix(".wav.tmp")
    try:
        _run_media_tool(
            "ffmpeg",
            [
                "-y", "-v", "error", "-i", str(source), "-map", "0:a:0", "-vn",
                "-ac", str(channels), "-ar", str(sample_rate), "-c:a", "pcm_s16le",
                "-f", "wav", str(temp),
            ],
        )
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)


def _extract_profile_clip(source: Path, target: Path, *, start_sec: float, duration_sec: float) -> None:
    """Cut a 24 kHz mono region out of a Studio project source. Shared by
    voice-profile, narration, and conversion clips."""
    temp = target.with_suffix(".wav.tmp")
    try:
        _run_media_tool(
            "ffmpeg",
            [
                "-y", "-v", "error", "-ss", f"{start_sec:.4f}", "-i", str(source),
                "-t", f"{duration_sec:.4f}", "-map", "0:a:0", "-vn", "-ac", "1",
                "-ar", "24000", "-c:a", "pcm_s16le", "-f", "wav", str(temp),
            ],
            timeout=180,
        )
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)


def _create_video_preview(source: Path, target: Path) -> None:
    """Create an H.264/AAC MP4 proxy that the embedded Chromium can decode."""
    temp = target.with_name(f".{target.stem}-building.mp4")
    try:
        _run_media_tool(
            "ffmpeg",
            [
                "-y", "-v", "error", "-i", str(source),
                "-map", "0:v:0", "-map", "0:a:0", "-sn", "-dn",
                "-vf", "scale=w='min(1280,iw)':h=-2:flags=lanczos,format=yuv420p",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                "-profile:v", "main", "-level:v", "4.0",
                "-c:a", "aac", "-b:a", "128k", "-ac", "2",
                "-movflags", "+faststart", "-max_muxing_queue_size", "1024",
                "-f", "mp4", str(temp),
            ],
            timeout=3600,
        )
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)


def _waveform_peaks(path: Path, buckets: int = 800) -> list[float]:
    try:
        with wave.open(str(path), "rb") as source:
            channels = source.getnchannels()
            width = source.getsampwidth()
            frames = source.getnframes()
            if width != 2 or frames <= 0:
                raise ValueError("Studio edit audio must be 16-bit PCM WAV.")
            frames_per_bucket = max(1, frames // buckets)
            peaks = []
            while len(peaks) < buckets:
                raw = source.readframes(frames_per_bucket)
                if not raw:
                    break
                samples = struct.iter_unpack("<h", raw)
                peak = max((abs(value[0]) for value in samples), default=0) / 32768.0
                peaks.append(round(min(1.0, peak), 4))
            return peaks
    except wave.Error as exc:
        # Python 3.11 rejects WAVE_FORMAT_EXTENSIBLE (65534), which is a
        # perfectly valid PCM format emitted by some phone/browser recorders
        # and FFmpeg channel layouts. Parse that narrow PCM variant directly.
        try:
            return _waveform_peaks_extensible(path, buckets=buckets)
        except ValueError:
            raise ValueError(f"Studio edit audio is not readable PCM WAV: {exc}") from exc


def _waveform_peaks_extensible(path: Path, *, buckets: int = 800) -> list[float]:
    with Path(path).open("rb") as source:
        header = source.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:] != b"WAVE":
            raise ValueError("Not a RIFF WAVE file.")
        format_info = None
        data_offset = None
        data_size = 0
        while True:
            chunk_header = source.read(8)
            if len(chunk_header) < 8:
                break
            chunk_id, chunk_size = struct.unpack("<4sI", chunk_header)
            chunk_start = source.tell()
            if chunk_id == b"fmt ":
                payload = source.read(chunk_size)
                if len(payload) < 16:
                    raise ValueError("Invalid WAVE format chunk.")
                tag, channels, _rate, _byte_rate, block_align, bits = struct.unpack(
                    "<HHIIHH", payload[:16]
                )
                if tag == 0xFFFE:
                    if len(payload) < 40:
                        raise ValueError("Invalid extensible WAVE format chunk.")
                    tag = struct.unpack("<H", payload[24:26])[0]
                format_info = (tag, channels, block_align, bits)
            elif chunk_id == b"data":
                data_offset = chunk_start
                data_size = chunk_size
            source.seek(chunk_start + chunk_size + (chunk_size % 2))
            if format_info is not None and data_offset is not None:
                break

        if format_info is None or data_offset is None:
            raise ValueError("WAVE format or data chunk is missing.")
        tag, channels, block_align, bits = format_info
        if tag != 1 or bits != 16 or channels < 1 or block_align != channels * 2:
            raise ValueError("Extensible WAVE is not 16-bit PCM.")
        frames = data_size // block_align
        if frames <= 0:
            raise ValueError("WAVE data is empty.")
        frames_per_bucket = max(1, frames // buckets)
        source.seek(data_offset)
        remaining = data_size
        peaks = []
        while remaining > 0 and len(peaks) < buckets:
            read_size = min(remaining, frames_per_bucket * block_align)
            raw = source.read(read_size)
            if not raw:
                break
            remaining -= len(raw)
            usable = len(raw) - (len(raw) % 2)
            samples = struct.iter_unpack("<h", raw[:usable])
            peak = max((abs(value[0]) for value in samples), default=0) / 32768.0
            peaks.append(round(min(1.0, peak), 4))
        return peaks


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_atomic(source: Path, target: Path) -> None:
    """Atomic copy with fsync; used for output writes from generation/import."""
    import shutil
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}-", suffix=".tmp", dir=target.parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as output, source.open("rb") as input_handle:
            shutil.copyfileobj(input_handle, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, target)
    except Exception:
        temp.unlink(missing_ok=True)
        raise


def import_source_path(
    project_id: str,
    staged: Path,
    filename: str,
    *,
    capture_method: str = "upload",
) -> dict:
    from .recordings import CAPTURE_METHODS, RECORDING_RETENTION_SEC
    safe_id = _manifest._validate_project_id(project_id)
    staged = Path(staged)
    capture_method = str(capture_method or "").strip().lower()
    if capture_method not in CAPTURE_METHODS:
        raise ValueError("Invalid Studio capture method.")
    if not staged.is_file() or staged.stat().st_size <= 0:
        raise ValueError("Uploaded media is empty.")
    if staged.stat().st_size > _manifest.MAX_SOURCE_BYTES:
        raise ValueError("Studio media may not exceed 2 GB.")
    extension = Path(filename or "").suffix.lower()
    if extension not in MEDIA_EXTENSIONS:
        raise ValueError("Unsupported media type.")
    metadata = _probe_media(staged)
    source_id = uuid.uuid4().hex
    target_root = _manifest.project_dir(safe_id)
    target = target_root / "sources" / f"{source_id}{extension}"
    temp_target = target.with_suffix(f"{extension}.tmp")
    audio = target_root / "derived" / f"{source_id}.wav"
    preview = target_root / "derived" / f"{source_id}-preview.mp4" if metadata["hasVideo"] else None
    waveform_path = target_root / "derived" / f"{source_id}-waveform.json"
    try:
        with staged.open("rb") as input_handle, temp_target.open("wb") as output_handle:
            shutil.copyfileobj(input_handle, output_handle, length=1024 * 1024)
            output_handle.flush()
            os.fsync(output_handle.fileno())
        os.replace(temp_target, target)
        _extract_edit_audio(
            target,
            audio,
            sample_rate=metadata["sampleRate"],
            channels=metadata["channels"],
        )
        if preview is not None:
            _create_video_preview(target, preview)
        peaks = _waveform_peaks(audio)
        _manifest._write_json_atomic(waveform_path, peaks)
    except Exception:
        temp_target.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        audio.unlink(missing_ok=True)
        waveform_path.unlink(missing_ok=True)
        if preview is not None:
            preview.unlink(missing_ok=True)
        raise

    created_at = time.time()
    record = {
        "id": source_id,
        "fileName": Path(filename).name,
        "captureMethod": capture_method,
        "mediaType": "VIDEO" if metadata["hasVideo"] else "AUDIO",
        "durationSec": metadata["durationSec"],
        "sampleRate": metadata["sampleRate"],
        "channels": metadata["channels"],
        "formatName": metadata["formatName"],
        "sizeBytes": target.stat().st_size,
        "sha256": _sha256_file(target),
        "waveformPeaks": peaks,
        "path": str(target.relative_to(target_root)).replace("\\", "/"),
        "audioPath": str(audio.relative_to(target_root)).replace("\\", "/"),
        "waveformPath": str(waveform_path.relative_to(target_root)).replace("\\", "/"),
        "createdAt": created_at,
    }
    if capture_method == "recording":
        record["expiresAt"] = created_at + RECORDING_RETENTION_SEC
    if preview is not None:
        record["previewPath"] = str(preview.relative_to(target_root)).replace("\\", "/")
    with _manifest._project_lock(safe_id):
        manifest = _manifest._load_manifest(safe_id)
        manifest.setdefault("sources", []).append(record)
        manifest["updatedAt"] = time.time()
        _manifest._write_json_atomic(_manifest._manifest_path(safe_id), manifest)
    return _manifest._public_project(manifest)["sources"][-1]
