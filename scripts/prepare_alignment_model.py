#!/usr/bin/env python3
"""Stage the bundled CTC forced-alignment model for BookVoice.

Downloads a wav2vec2 CTC acoustic model from Hugging Face, converts the
weights to float16 (halves the shipped size; the aligner upcasts to float32
when running on CPU), and saves it under backend/data/models/alignment/<lang>/
where build.py bundles it with the other model weights.

Run once per checkout (requires network + the backend venv):
    backend/.venv/Scripts/python.exe scripts/prepare_alignment_model.py

The staged directory is offline-complete: config.json, model.safetensors,
vocab.json, tokenizer_config.json, preprocessor_config.json, and a
provenance.json recording the source repo and revision.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# English CTC model: char-level vocab with '|' word delimiters, 16 kHz,
# 20 ms frame stride. Small enough to bundle, accurate enough that forced
# alignment on clean TTS audio is limited by frame stride, not the model.
DEFAULT_REPO = "facebook/wav2vec2-base-960h"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=DEFAULT_REPO, help="Hugging Face model repo")
    parser.add_argument("--language", default="en", help="BookVoice language id")
    parser.add_argument(
        "--out",
        default=None,
        help="Output dir (default backend/data/models/alignment/<language>)",
    )
    args = parser.parse_args()

    import torch
    from transformers import AutoProcessor, Wav2Vec2ForCTC

    out_dir = Path(args.out) if args.out else ROOT / "backend" / "data" / "models" / "alignment" / args.language
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[alignment] downloading {args.repo} …")
    model = Wav2Vec2ForCTC.from_pretrained(args.repo)
    processor = AutoProcessor.from_pretrained(args.repo)

    model = model.half().eval()
    print(f"[alignment] saving float16 weights -> {out_dir}")
    model.save_pretrained(out_dir, safe_serialization=True)
    processor.save_pretrained(out_dir)

    revision = getattr(getattr(model, "config", None), "_commit_hash", None)
    provenance = {
        "source_repo": args.repo,
        "revision": revision,
        "dtype": "float16",
        "staged_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "purpose": "CTC forced alignment for word-level narration timestamps",
    }
    (out_dir / "provenance.json").write_text(
        json.dumps(provenance, indent=2) + "\n", encoding="utf-8"
    )

    total = sum(f.stat().st_size for f in out_dir.rglob("*") if f.is_file())
    print(f"[alignment] staged {total / (1024 * 1024):.1f} MiB in {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
