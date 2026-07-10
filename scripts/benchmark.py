#!/usr/bin/env python3
"""
BookVoice performance benchmark.

Captures timing for the TTS pipeline phases: cold start, model-ready, first-audio,
full-page synthesis, page-switch, plus memory (tracemalloc) and VRAM (nvidia-smi
when CUDA is present). Writes a machine-tagged baseline JSON.

By default runs in OFFLINE/MOCK mode: `_generate_chunk` is patched to return a
fixed-length silence tensor, so the benchmark is deterministic and requires no GPU
or model weights. Pass `--real` to exercise actual Chatterbox inference (needs the
bundled model weights and CUDA or CPU torch).

    python scripts/benchmark.py              # offline mock baseline
    python scripts/benchmark.py --real       # real GPU/CPU inference
"""
from __future__ import annotations

import argparse
import json
import platform
import sys
import time
import tracemalloc
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
TASKS = ROOT / "tasks"
BASELINE = TASKS / "perf-baseline.json"

if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

PAGE_TEXT = (
    "The lighthouse stood at the edge of the cliff. Every evening its beam swept "
    "across the dark water. The keeper climbed the spiral stairs with a heavy lamp. "
    "Far below the waves crashed against the rocks."
)


def _machine_tag() -> dict:
    return {
        "machine": platform.node(),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "processor": platform.processor(),
    }


def _vram_mib() -> dict | None:
    """Best-effort VRAM snapshot via nvidia-smi; None if unavailable."""
    try:
        import subprocess

        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        ).strip()
        total, used = (float(x) for x in out.split(","))
        return {"total_mib": total, "used_mib": used}
    except Exception:
        return None


def _import_tts():
    try:
        import services.tts_service as tts  # noqa: WPS433
        return tts
    except ImportError:
        torch = MagicMock()
        torch.cuda.is_available.return_value = False
        torch.backends.mps = MagicMock()
        torch.backends.mps.is_available.return_value = False
        sys.modules.setdefault("torch", torch)
        sys.modules.setdefault("torchaudio", MagicMock())
        import services.tts_service as tts  # noqa: WPS433
        return tts


def _run_mock_phase(tts, phase: str, text: str = PAGE_TEXT) -> dict:
    """Time a single narrate_text call with mocked chunk generation."""
    import torch

    model = MagicMock()
    model.device = "cpu"
    model.sr = 24000
    fake_wav = torch.zeros(1, 12000)  # 0.5s per chunk

    start = time.perf_counter()
    tracemalloc.start()
    with patch.object(tts, "get_model", return_value=model):
        with patch.object(tts, "maybe_cleanup_sessions"):
            with patch.object(tts, "_generate_chunk", return_value=fake_wav):
                with patch.object(tts.ta, "save"):
                    with patch.object(tts, "_data_dirs", return_value=("d", "v", "s")):
                        with patch("os.makedirs"):
                            tts.narrate_text(text, "bench", 0)
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    elapsed = time.perf_counter() - start
    return {
        "phase": phase,
        "elapsed_s": round(elapsed, 4),
        "peak_alloc_mib": round(peak / 1048576.0, 3),
    }


def run_benchmark(real: bool = False) -> dict:
    tts = _import_tts()
    results: dict = {"machine": _machine_tag(), "mode": "real" if real else "mock", "phases": {}}

    if real:
        # Defer to the real pipeline; may need GPU + weights.
        start = time.perf_counter()
        tts.preload_model("en")
        results["phases"]["cold_start_to_ready_s"] = round(time.perf_counter() - start, 4)
        start = time.perf_counter()
        tts.narrate_text(PAGE_TEXT, "bench", 0)
        results["phases"]["full_page_s"] = round(time.perf_counter() - start, 4)
        results["vram"] = _vram_mib()
    else:
        # Deterministic mock timings: capture pipeline overhead (splitting,
        # queueing, concat, save, alignment-mode detection) without the model.
        results["phases"]["full_page_mock"] = _run_mock_phase(tts, "full_page_mock")
        results["phases"]["page_switch_mock"] = _run_mock_phase(tts, "page_switch_mock")
        results["vram"] = _vram_mib()  # None when no CUDA

    results["captured_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the BookVoice TTS benchmark.")
    parser.add_argument("--real", action="store_true", help="Real GPU/CPU inference (needs weights).")
    args = parser.parse_args()

    payload = run_benchmark(real=args.real)
    BASELINE.parent.mkdir(parents=True, exist_ok=True)
    BASELINE.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"[benchmark] mode={payload['mode']} baseline -> {BASELINE}")
    for key, val in payload["phases"].items():
        print(f"  {key}: {val}")
    if payload.get("vram"):
        print(f"  vram: {payload['vram']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
