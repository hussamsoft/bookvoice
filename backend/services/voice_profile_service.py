"""Reusable voice-profile storage layered over the legacy voices/*.wav contract."""
from __future__ import annotations

import array
import hashlib
import json
import math
import os
import shutil
import struct
import tempfile
import time
import wave
from pathlib import Path

from services.path_utils import validate_voice_id
from services.storage_utils import replace_file_with_retry


def voices_dir() -> Path:
    configured = os.environ.get("VOICE_DATA_DIR", "").strip()
    root = Path(configured) if configured else Path(os.environ.get("DATA_DIR", "data")) / "voices"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_name(name: str) -> tuple[str, str]:
    display = " ".join(
        "".join(c for c in str(name or "") if c.isalnum() or c in (" ", "-", "_")).split()
    ).strip()
    if not display:
        raise ValueError("Voice profile name is required.")
    voice_id = validate_voice_id(display.replace(" ", "_").lower())
    return voice_id, display


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json_atomic(path: Path, payload: dict) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}-", suffix=".tmp", dir=path.parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        replace_file_with_retry(temp, path)
    except Exception:
        temp.unlink(missing_ok=True)
        raise


FRAME_SECONDS = 0.02
# Conversational English averages roughly 4.3 syllables per second; the ratio
# between a reference clip and that baseline maps onto the Studio pace control.
BASELINE_SYLLABLES_PER_SEC = 4.3
BASELINE_DYNAMICS_DB = 10.0


def _frame_envelope(samples: list[int] | "array.array", sample_rate: int) -> list[float]:
    frame = max(1, int(sample_rate * FRAME_SECONDS))
    envelope = []
    for offset in range(0, len(samples) - frame + 1, frame):
        total = 0.0
        for index in range(offset, offset + frame):
            value = float(samples[index])
            total += value * value
        envelope.append(math.sqrt(total / frame) / 32768.0)
    return envelope


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(fraction * (len(ordered) - 1)))))
    return ordered[index]


def speech_metrics(envelope: list[float]) -> dict:
    """Estimate speaking rate and dynamic range from a loudness envelope."""
    if len(envelope) < 5:
        return {"syllablesPerSec": 0.0, "dynamicsDb": 0.0, "voicedPercent": 0.0}
    loud = _percentile(envelope, 0.95)
    floor = max(1e-5, loud * 0.10)
    voiced = [value for value in envelope if value >= floor]
    voiced_percent = 100.0 * len(voiced) / len(envelope)
    quiet = max(1e-5, _percentile(voiced, 0.10))
    strong = max(quiet, _percentile(voiced, 0.90))
    dynamics_db = 20 * math.log10(strong / quiet)

    # Count envelope peaks separated by at least 120 ms: a robust, well-known
    # proxy for syllable nuclei that needs no phonetic model.
    peak_gate = max(floor, loud * 0.35)
    min_distance = max(1, int(0.12 / FRAME_SECONDS))
    peaks = 0
    last_peak = -min_distance
    for index in range(1, len(envelope) - 1):
        value = envelope[index]
        if value < peak_gate:
            continue
        if value >= envelope[index - 1] and value > envelope[index + 1]:
            if index - last_peak >= min_distance:
                peaks += 1
                last_peak = index
    duration = len(envelope) * FRAME_SECONDS
    return {
        "syllablesPerSec": round(peaks / duration if duration > 0 else 0.0, 3),
        "dynamicsDb": round(dynamics_db, 2),
        "voicedPercent": round(voiced_percent, 2),
    }


def suggest_generation_settings(metrics: dict) -> dict:
    """Derive narration controls that already match the imported speaker.

    This removes the trial-and-error slider tuning that was previously needed to
    make a cloned voice sound like the recording it came from.
    """
    rate = float(metrics.get("syllablesPerSec") or 0.0)
    dynamics = float(metrics.get("dynamicsDb") or 0.0)
    if rate <= 0:
        pace = 1.0
    else:
        pace = max(0.85, min(1.15, rate / BASELINE_SYLLABLES_PER_SEC))
    expression = max(0.2, min(0.8, 0.5 + ((dynamics - BASELINE_DYNAMICS_DB) / 30.0)))
    temperature = 0.7 if dynamics < 8.0 else 0.8
    return {
        "pace": round(pace, 2),
        "expression": round(expression, 2),
        "temperature": temperature,
        "guidance": None,
        "seed": None,
    }


def analyze_reference(path: Path, *, min_seconds: float = 5.0, max_seconds: float = 30.0) -> dict:
    try:
        with wave.open(str(path), "rb") as source:
            channels = source.getnchannels()
            sample_width = source.getsampwidth()
            sample_rate = source.getframerate()
            frame_count = source.getnframes()
            if sample_width != 2:
                raise ValueError("Voice profiles must use 16-bit PCM audio.")
            duration = frame_count / float(sample_rate or 1)
            if duration < min_seconds:
                raise ValueError(
                    f"Voice sample is too short ({duration:.1f}s). Select at least {min_seconds:g} seconds."
                )
            if duration > max_seconds:
                raise ValueError(
                    f"Voice sample is too long ({duration:.1f}s). Select no more than {max_seconds:g} seconds."
                )
            peak = 0
            squares = 0.0
            total = 0
            clipped = 0
            silent = 0
            pcm = array.array("h")
            while True:
                raw = source.readframes(65_536)
                if not raw:
                    break
                for (sample,) in struct.iter_unpack("<h", raw):
                    magnitude = abs(sample)
                    peak = max(peak, magnitude)
                    squares += float(sample) * sample
                    total += 1
                    clipped += int(magnitude >= 32_440)
                    silent += int(magnitude <= 328)
                    pcm.append(sample)
    except wave.Error as exc:
        raise ValueError(f"Voice sample is not a valid PCM WAV file: {exc}") from exc

    metrics = speech_metrics(
        _frame_envelope(pcm, max(1, int(sample_rate) * max(1, int(channels))))
    )
    rms = math.sqrt(squares / max(1, total))
    peak_db = 20 * math.log10(max(1.0, peak) / 32768.0)
    rms_db = 20 * math.log10(max(1.0, rms) / 32768.0)
    clipping_percent = 100.0 * clipped / max(1, total)
    silence_percent = 100.0 * silent / max(1, total)
    warnings = []
    if clipping_percent > 0.5:
        warnings.append("The sample contains clipping; a quieter selection may sound cleaner.")
    if silence_percent > 45:
        warnings.append("The sample contains substantial silence; select more continuous speech.")
    if rms_db < -35:
        warnings.append("The sample is quiet; a stronger recording may improve voice matching.")
    return {
        "durationSec": round(duration, 3),
        "sampleRate": sample_rate,
        "channels": channels,
        "peakDb": round(peak_db, 2),
        "rmsDb": round(rms_db, 2),
        "clippingPercent": round(clipping_percent, 3),
        "silencePercent": round(silence_percent, 2),
        "warnings": warnings,
        "speechMetrics": metrics,
    }


def create_profile(
    source_wav: Path,
    name: str,
    *,
    consent_confirmed: bool,
    source_info: dict | None = None,
    min_seconds: float = 5.0,
    max_seconds: float = 30.0,
) -> dict:
    if not consent_confirmed:
        raise ValueError("Confirm that you own or have permission to clone this voice.")
    voice_id, display_name = _safe_name(name)
    source = Path(source_wav)
    quality = analyze_reference(source, min_seconds=min_seconds, max_seconds=max_seconds)
    root = voices_dir()
    target = root / f"{voice_id}.wav"
    fd, temp_name = tempfile.mkstemp(prefix=f".{voice_id}-", suffix=".wav.tmp", dir=root)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as output, source.open("rb") as input_handle:
            shutil.copyfileobj(input_handle, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        replace_file_with_retry(temp, target)
    except Exception:
        temp.unlink(missing_ok=True)
        raise

    info = source_info if isinstance(source_info, dict) else {}
    now = time.time()
    metadata = {
        "schemaVersion": 1,
        "id": voice_id,
        "name": display_name,
        "createdAt": now,
        "updatedAt": now,
        "sourceType": str(info.get("kind") or "AUDIO").upper(),
        "sourceFileName": Path(str(info.get("fileName") or "")).name or None,
        "consentConfirmed": True,
        "referenceSha256": _sha256_file(target),
        "quality": quality,
        "suggestedSettings": suggest_generation_settings(quality.get("speechMetrics") or {}),
        "isLegacy": False,
    }
    _write_json_atomic(root / f"{voice_id}.json", metadata)
    for cache in root.glob(f"{voice_id}.*.conds.pt"):
        cache.unlink(missing_ok=True)
    return metadata


def list_profiles() -> list[dict]:
    result = []
    for wav_path in sorted(voices_dir().glob("*.wav"), key=lambda path: path.stem.lower()):
        metadata_path = wav_path.with_suffix(".json")
        metadata = None
        try:
            loaded = json.loads(metadata_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict) and loaded.get("id") == wav_path.stem:
                metadata = loaded
        except (OSError, json.JSONDecodeError):
            pass
        if metadata is None:
            metadata = {
                "schemaVersion": 1,
                "id": wav_path.stem,
                "name": wav_path.stem.replace("_", " ").title(),
                "sourceType": "LEGACY",
                "quality": None,
                "isLegacy": True,
            }
        result.append(metadata)
    return result


def delete_profile(voice_id: str) -> None:
    safe_id = validate_voice_id(voice_id)
    reference = voices_dir() / f"{safe_id}.wav"
    if not reference.is_file():
        raise FileNotFoundError("Voice profile was not found.")
    reference.unlink()
    (voices_dir() / f"{safe_id}.json").unlink(missing_ok=True)
    for cache in voices_dir().glob(f"{safe_id}.*.conds.pt"):
        cache.unlink(missing_ok=True)
