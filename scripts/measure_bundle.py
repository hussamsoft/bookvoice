#!/usr/bin/env python3
"""
Measure BookVoice frontend bundle sizes and record a reproducible baseline.

Scans the built assets referenced by index.html, computes the initial-entry
chunk size plus a per-chunk breakdown, and writes tasks/bundle-baseline.json.

The initial-entry budget (default 350 kB minified) comes from the BookVoice
stabilization plan (tasks/plan.md, Task 11). A warning is printed — not a
hard failure — so normal React growth doesn't break the build, while the
number stays reproducible and auditable.

Run from the repo root after building the frontend:
    python scripts/measure_bundle.py
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIST = ROOT / "frontend" / "dist"
TASKS = ROOT / "tasks"
BASELINE_JSON = TASKS / "bundle-baseline.json"

# Pre-split baseline recorded during the stabilization audit (tasks/plan.md).
BASELINE_PRE_SPLIT_KIB = 672.16
DEFAULT_BUDGET_KIB = 350.0


def _kib(path: Path) -> float:
    return round(path.stat().st_size / 1024.0, 2)


def _initial_entry_refs(index_html: Path) -> list[Path]:
    """Return the local /assets/... files loaded unconditionally by index.html."""
    text = index_html.read_text(encoding="utf-8")
    refs = re.findall(r'(?:src|href)="(/assets/[^"]+)"', text)
    return [FRONTEND_DIST / ref.lstrip("/") for ref in refs]


def measure(assets_dir: Path = FRONTEND_DIST, index_html: Path | None = None) -> dict:
    index_html = index_html or (assets_dir / "index.html")
    if not index_html.is_file():
        raise SystemExit(f"index.html not found: {index_html}")

    entry_refs = _initial_entry_refs(index_html)
    initial_size = sum(_kib(p) for p in entry_refs if p.is_file())

    chunks = {}
    for asset in sorted(assets_dir.glob("assets/*")):
        if asset.is_file():
            chunks[asset.name] = _kib(asset)

    pdf_worker = next(
        (size for name, size in chunks.items() if name.startswith("pdf.worker")),
        None,
    )

    return {
        "measured_on": str(date.today()),
        "baseline_pre_split_kib": BASELINE_PRE_SPLIT_KIB,
        "budget_kib": DEFAULT_BUDGET_KIB,
        "initial_entry_kib": round(initial_size, 2),
        "pdf_worker_kib": pdf_worker,
        "chunks_kib": chunks,
    }


def write_baseline(payload: dict, target: Path = BASELINE_JSON) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure and record frontend bundle sizes.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Warn (do not fail) if the initial entry exceeds the budget.",
    )
    args = parser.parse_args()

    if not FRONTEND_DIST.is_dir():
        raise SystemExit("Frontend build not found. Run `npm run build` in frontend/ first.")

    payload = measure()
    write_baseline(payload)

    initial = payload["initial_entry_kib"]
    budget = payload["budget_kib"]
    print(f"[bundle] initial entry: {initial:.2f} KiB (budget {budget:.0f} KiB)")
    print(f"[bundle] pdf worker:    {payload['pdf_worker_kib']} KiB")
    print(f"[bundle] baseline JSON: {BASELINE_JSON}")

    if args.check and initial > budget:
        print(
            f"[bundle] WARNING: initial entry {initial:.2f} KiB exceeds the "
            f"{budget:.0f} KiB budget"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
