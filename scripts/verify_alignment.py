#!/usr/bin/env python3
"""End-to-end accuracy check for CTC word alignment on real TTS audio.

Synthesizes a paragraph with the bundled Chatterbox voice, force-aligns the
known text, then *proves* the timestamps by slicing each word's [start, end]
span out of the audio and greedy-decoding the slice with the same acoustic
model. A slice that decodes to its own word means clicking that word replays
the right audio.

Run with the backend venv (GPU strongly recommended):
    backend/.venv/Scripts/python.exe scripts/verify_alignment.py
"""
from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

os.environ.setdefault("MODEL_DIR", str(BACKEND / "data" / "models"))
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="bookvoice_align_check_"))

TEXT = (
    "The lighthouse keeper climbed the narrow spiral staircase every evening. "
    "Storms had battered the coast for three days, and the fishing boats stayed "
    "in the harbor. She trimmed the lamp, polished the great lens, and watched "
    "the horizon for the mail steamer from the mainland."
)


def normalize(word: str) -> str:
    return re.sub(r"[^A-Za-z']", "", word).upper()


def main() -> int:
    import torch
    import torchaudio

    from services.alignment_service import _load_ctc, align_words, alignment_mode
    from services.tts_service import narrate_text

    print(f"[verify] alignment_mode = {alignment_mode()}")
    if alignment_mode() != "ctc":
        print("[verify] FAIL: expected ctc mode (is the model staged?)")
        return 1

    print("[verify] synthesizing test paragraph …")
    result = narrate_text(TEXT, "alignment-verify", 1)
    wav_path = os.path.join(
        os.environ["DATA_DIR"],
        "sessions",
        str(result["audio_url"]).removeprefix("/sessions/"),
    )
    print(f"[verify] audio: {wav_path} ({result['duration_s']}s, "
          f"{len(result['segments'])} chunks)")

    timings = result.get("word_timings")
    if not timings:
        timings = align_words(TEXT, wav_path, "en", segments=result["segments"])
    if not timings:
        print("[verify] FAIL: aligner returned nothing")
        return 1

    words = TEXT.split()
    if len(timings) != len(words):
        print(f"[verify] FAIL: {len(timings)} timings for {len(words)} words")
        return 1

    # Decode each word's slice with the same acoustic model.
    model, vocab, blank_id, device = _load_ctc("en")
    id_to_char = {v: k for k, v in vocab.items()}
    waveform, sr = torchaudio.load(wav_path)
    waveform = waveform.mean(dim=0)
    if sr != 16000:
        waveform = torchaudio.functional.resample(waveform, sr, 16000)

    from difflib import SequenceMatcher

    def decode_slice(start_s: float, end_s: float) -> str:
        lo = max(0, int((start_s) * 16000))
        hi = min(waveform.shape[-1], int((end_s) * 16000))
        piece = waveform[lo:hi]
        if piece.shape[-1] < 400:
            return ""
        x = (piece - piece.mean()) / torch.sqrt(piece.var() + 1e-7)
        x = x.unsqueeze(0).to(device=device, dtype=next(model.parameters()).dtype)
        with torch.inference_mode():
            ids = model(x).logits.argmax(dim=-1)[0].tolist()
        decoded, last = [], blank_id
        for i in ids:
            if i != blank_id and i != last:
                decoded.append(id_to_char.get(i, ""))
            last = i
        return "".join(decoded).replace("|", "").strip()

    def similarity(a: str, b: str) -> float:
        if not a or not b:
            return 0.0
        return SequenceMatcher(None, a, b).ratio()

    # Two checks per word slice, decoded independently by re-running the
    # acoustic model on the cut audio:
    #   1. hard: the slice must never resemble a NEIGHBOUR more than its own
    #      word ("reads something else" — the reported bug).
    #   2. soft: most slices should resemble their own word. Isolated 0.2 s
    #      cuts of fluent speech decode imperfectly, so this is a sanity bar,
    #      not an ASR benchmark.
    pad = 0.08
    matches, wrong_word, checked = 0, 0, []
    mismatches = []
    prev_start = -1.0
    for idx, item in enumerate(timings):
        assert item["start_s"] >= prev_start, "timings must be monotonic"
        prev_start = item["start_s"]

        target = normalize(item["word"])
        if len(target) < 4:
            continue  # isolated clips of tiny function words don't decode reliably
        decoded = decode_slice(item["start_s"] - pad, item["end_s"] + pad)
        sim_self = similarity(decoded, target)
        sim_prev = similarity(decoded, normalize(words[idx - 1])) if idx > 0 else 0.0
        sim_next = (
            similarity(decoded, normalize(words[idx + 1])) if idx + 1 < len(words) else 0.0
        )

        checked.append(target)
        if sim_self >= 0.5:
            matches += 1
        else:
            mismatches.append(
                (item["word"], decoded, item["start_s"], item["end_s"], sim_self)
            )
        if max(sim_prev, sim_next) > sim_self + 0.2:
            wrong_word += 1

    total = len(checked)
    rate = matches / total if total else 0
    print(f"[verify] slice matches own word: {matches}/{total} ({rate:.1%})")
    print(f"[verify] slices sounding like a neighbour instead: {wrong_word}")
    for word, decoded, s, e, sim in mismatches[:10]:
        print(f"  weak: '{word}' [{s:.2f}-{e:.2f}s] decoded '{decoded}' (sim {sim:.2f})")

    if wrong_word > 0:
        print("[verify] FAIL: some slices speak a neighbouring word")
        return 1
    if rate < 0.8:
        print("[verify] FAIL: below 80% self-match sanity bar")
        return 1
    print("[verify] PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
