#!/usr/bin/env python3
"""Ensure bundled default voice reference clips exist for release builds."""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path


DEFAULT_VOICE_NAMES = (
    "Aria",
    "Ryan",
    "Sonia",
    "Guy",
    "Natasha",
    "Christopher",
)


def write_reference_wav(path: Path, seed: str, seconds: float = 4.0, rate: int = 24000) -> None:
    """Write a short synthetic PCM clip usable as a cloning prompt."""
    path.parent.mkdir(parents=True, exist_ok=True)
    nframes = int(rate * seconds)
    base_hz = 180 + (sum(ord(c) for c in seed) % 220)

    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        frames = bytearray()
        for index in range(nframes):
            t = index / rate
            attack = min(1.0, t / 0.15)
            release = min(1.0, max(0.0, (seconds - t) / 0.2))
            envelope = attack * release
            sample = envelope * 7000 * math.sin(2 * math.pi * base_hz * t)
            frames += struct.pack("<h", max(-32767, min(32767, int(sample))))
        handle.writeframes(frames)


def _copy_tree(src: Path, dst: Path) -> int:
    if not src.is_dir():
        return 0
    dst.mkdir(parents=True, exist_ok=True)
    copied = 0
    for wav in sorted(src.glob("*.wav")):
        target = dst / wav.name
        if not target.exists() or target.stat().st_size != wav.stat().st_size:
            target.write_bytes(wav.read_bytes())
        copied += 1
    return copied


def ensure_default_voices(root: Path, *, min_voices: int = len(DEFAULT_VOICE_NAMES)) -> Path:
    """Populate voices/ and dist/data/default_voices with at least min_voices clips."""
    voices_dir = root / "voices"
    voices_dir.mkdir(parents=True, exist_ok=True)

    sources = (
        voices_dir,
        root / "backend" / "data" / "default_voices",
        root / "backend" / "data" / "voices",
    )
    for source in sources:
        _copy_tree(source, voices_dir)

    existing = sorted(voices_dir.glob("*.wav"))
    if len(existing) < min_voices:
        for name in DEFAULT_VOICE_NAMES:
            target = voices_dir / f"{name}.wav"
            if not target.is_file():
                write_reference_wav(target, name)

    packaged = root / "dist" / "data" / "default_voices"
    count = _copy_tree(voices_dir, packaged)
    if count < min_voices:
        raise SystemExit(
            f"Expected at least {min_voices} default voice clips, found {count} in {voices_dir}"
        )
    return voices_dir


if __name__ == "__main__":
    ensure_default_voices(Path(__file__).resolve().parent.parent)
