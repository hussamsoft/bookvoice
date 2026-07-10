#!/usr/bin/env python3
"""
Generate reproducible BookVoice test fixtures.

Produces small, valid PDFs (English prose, Arabic text, two-column, repeated-word,
punctuation-edge) by hand-crafting minimal PDF structure — no reportlab dependency —
and synthetic fixed-timing WAVs with documented word boundaries for highlight-drift
regression tests.

Fixtures are deterministic and checked into tests/fixtures/ so every test run uses
identical inputs. Rerun after editing the corpus.

    python scripts/make_fixtures.py
"""
from __future__ import annotations

import hashlib
import json
import struct
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"

# A typical BookVoice narration sample rate (Chatterbox default).
SAMPLE_RATE = 24000


# --------------------------------------------------------------------------- #
# Minimal PDF writer (no external deps)
# --------------------------------------------------------------------------- #
def _pdf_object(contents: bytes) -> bytes:
    return contents


def _text_pdf(lines: list[str], *, two_column: bool = False) -> bytes:
    """Build a minimal but valid single- or two-page-column PDF.

    Each entry in `lines` becomes a visible text row. For two-column layout the
    second half of the lines is offset to the right column on the same page.
    """
    page_width, page_height = 612, 792  # US Letter points
    left_margin, top_margin, line_height = 72, 720, 14
    col_gap = 40

    def esc(s: str) -> str:
        return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")

    if two_column:
        col_count = (len(lines) + 1) // 2
        left = lines[:col_count]
        right = lines[col_count:]
        rows = []
        for i, text in enumerate(left):
            y = top_margin - i * line_height
            rows.append(f"BT /F1 10 Tf {left_margin} {y} Td ({esc(text)}) Tj ET")
        for i, text in enumerate(right):
            y = top_margin - i * line_height
            x = page_width // 2 + col_gap
            rows.append(f"BT /F1 10 Tf {x} {y} Td ({esc(text)}) Tj ET")
        content = "\n".join(rows).encode("latin-1", errors="replace")
    else:
        rows = []
        for i, text in enumerate(lines):
            y = top_margin - i * line_height
            rows.append(f"BT /F1 10 Tf {left_margin} {y} Td ({esc(text)}) Tj ET")
        content = "\n".join(rows).encode("utf-8", errors="replace")

    # Assemble the PDF objects manually.
    objects: list[bytes] = []
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")  # 1: catalog
    objects.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")  # 2: pages
    objects.append(  # 3: page
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_width} {page_height}] "
        f"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".encode()
    )
    objects.append(  # 4: contents stream
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream"
    )
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")  # 5: font

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for idx, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{idx} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref_pos = len(out)
    out += b"xref\n0 " + str(len(objects) + 1).encode() + b"\n"
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        b"trailer\n<< /Size " + str(len(objects) + 1).encode()
        + b" /Root 1 0 R >>\nstartxref\n" + str(xref_pos).encode() + b"\n%%EOF"
    )
    return bytes(out)


# --------------------------------------------------------------------------- #
# Synthetic WAV writer (stdlib `wave`)
# --------------------------------------------------------------------------- #
def _write_wav(path: Path, samples: bytes, *, rate: int = SAMPLE_RATE, channels: int = 1):
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(rate)
        wf.writeframes(samples)


def _tone_samples(duration_s: float, *, freq: float = 440.0, rate: int = SAMPLE_RATE) -> bytes:
    """A short tone burst; used to give each word's audio a detectable onset."""
    import math

    n = int(duration_s * rate)
    frames = bytearray()
    for i in range(n):
        value = int(16000 * math.sin(2 * math.pi * freq * (i / rate)))
        frames += struct.pack("<h", value)
    return bytes(frames)


def _silence_samples(duration_s: float, *, rate: int = SAMPLE_RATE) -> bytes:
    n = int(duration_s * rate)
    return b"\x00\x00" * n


def _word_timings_wav(words: list[tuple[str, float]], path: Path):
    """Write a WAV where each word lasts `dur_s`, separated by 0.05s silence.

    Returns the matching word-timing manifest (start_s/end_s per word).
    """
    cursor = 0.0
    frames = bytearray()
    timings = []
    for idx, (word, dur) in enumerate(words):
        # Distinct frequency per word so onset detection is deterministic.
        freq = 300.0 + (idx * 47.0)
        frames += _tone_samples(dur, freq=freq)
        end = cursor + dur
        timings.append({"word": word, "start_s": round(cursor, 4), "end_s": round(end, 4)})
        cursor = end
        frames += _silence_samples(0.05)
        cursor += 0.05
    _write_wav(path, bytes(frames))
    return timings


# --------------------------------------------------------------------------- #
# Fixture corpus
# --------------------------------------------------------------------------- #
ENGLISH_PROSE = [
    "The lighthouse stood at the edge of the cliff.",
    "Every evening its beam swept across the dark water.",
    "The keeper climbed the spiral stairs with a heavy lamp.",
    "Far below, the waves crashed against the rocks.",
    "He had kept this light burning for thirty years.",
]

ARABIC_PROSE = [
    "وقف المنار عند حافة الجرف العالي.",
    "كل مساء يكتسح شعاعه الماء المظلم.",
    "صعد الحارس الدرج الحلزوني بمصباح ثقيل.",
    "في الاسفل تتحطم الامواج على الصخور.",
    "حافظ على هذه النار مشتعلة منذ ثلاثين عاما.",
]

PUNCTUATION_EDGE = [
    "Wait... what? No-- really?",
    "Dr. Smith (the author) said: \"Hello!\"",
    "Prices rose 12.5% in Q1, then fell.",
    "He whispered, 'shh... be quiet.'",
    "A, B, and C; or D/E?",
]

REPEATED_WORDS = [" ".join(["again"] * 8), " ".join(["stop"] * 8), "end"]


def build_all(target: Path = FIXTURES) -> list[Path]:
    target.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    corpus = [
        ("english.pdf", ENGLISH_PROSE, False),
        ("arabic.pdf", ARABIC_PROSE, False),
        ("two-column.pdf", ENGLISH_PROSE, True),
        ("punctuation.pdf", PUNCTUATION_EDGE, False),
        ("repeated-words.pdf", REPEATED_WORDS, False),
    ]
    for name, lines, two_col in corpus:
        p = target / name
        p.write_bytes(_text_pdf(lines, two_column=two_col))
        written.append(p)

    # Fixed-timing WAV fixtures with manifest (for highlight-drift regression).
    word_sets = {
        "timing_en.wav": [
            ("The", 0.18), ("lighthouse", 0.62), ("stood", 0.30),
            ("at", 0.14), ("the", 0.16), ("edge", 0.34), ("cliff", 0.48),
        ],
        "timing_ar.wav": [
            ("وقف", 0.30), ("المنار", 0.55), ("عند", 0.22), ("حافة", 0.40),
        ],
    }
    for wav_name, words in word_sets.items():
        wav_path = target / wav_name
        manifest = _word_timings_wav(words, wav_path)
        written.append(wav_path)
        manifest_path = target / (wav_name.replace(".wav", ".json"))
        manifest_path.write_text(
            json.dumps({"file": wav_name, "sample_rate": SAMPLE_RATE, "words": manifest}, indent=2),
            encoding="utf-8",
        )
        written.append(manifest_path)

    return written


def main() -> int:
    written = build_all()
    print(f"[fixtures] wrote {len(written)} files to {FIXTURES}")
    for p in written:
        print(f"  - {p.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
