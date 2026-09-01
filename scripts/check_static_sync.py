"""Fail when the committed backend/static drifts from a fresh frontend build.

v2.6.0 added the five-palette theme system but backend/static was never
rebuilt, so 2.6.0 and 2.6.1 both shipped the pre-theme UI. build.py already
compares the two trees, but it only runs in a full release build (which needs
FFmpeg, the models, and PyInstaller), so CI never saw the drift.

Run after `npm run build` in frontend/:

    python scripts/check_static_sync.py

.gitattributes normalizes text to LF in the repo while Windows checks it out
as CRLF, so text files are compared with their line endings normalized; only
genuinely binary assets are compared byte for byte.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "frontend" / "dist"
COMMITTED = ROOT / "backend" / "static"
CRLF = bytes((13, 10))


def _relative_files(root: Path) -> set[str]:
    return {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file()
    }


def _same_content(left: Path, right: Path) -> bool:
    """Compare bytes, ignoring the CRLF/LF difference git introduces on Windows."""
    raw_left = left.read_bytes()
    raw_right = right.read_bytes()
    if raw_left == raw_right:
        return True
    try:
        text_left = raw_left.decode("utf-8")
        text_right = raw_right.decode("utf-8")
    except UnicodeDecodeError:
        return False  # Binary asset: the byte comparison above is definitive.
    return text_left.replace("\r\n", "\n") == text_right.replace("\r\n", "\n")


def compare(build: Path = BUILD, committed: Path = COMMITTED) -> list[str]:
    """Return human-readable problems; empty means the trees agree."""
    if not build.is_dir():
        return [f"{build.relative_to(ROOT).as_posix()} missing — run `npm run build` in frontend/."]
    if not committed.is_dir():
        return [f"{committed.relative_to(ROOT).as_posix()} missing."]

    built = _relative_files(build)
    shipped = _relative_files(committed)

    problems = []
    for rel in sorted(built - shipped):
        problems.append(f"  missing from backend/static: {rel}")
    for rel in sorted(shipped - built):
        problems.append(f"  stale in backend/static (not in the build): {rel}")
    for rel in sorted(built & shipped):
        if not _same_content(build / rel, committed / rel):
            problems.append(f"  content differs: {rel}")
            problems.extend(_describe_difference(build / rel, committed / rel))
    return problems


def _describe_difference(build_file: Path, committed_file: Path) -> list[str]:
    """Explain *how* two files differ, so a CI failure is actionable.

    Without this a mismatch only says which file changed, which is not enough
    to tell a stale bundle apart from an encoding or line-ending artifact.
    """
    raw_build = build_file.read_bytes()
    raw_committed = committed_file.read_bytes()
    lines = [
        f"      built     {len(raw_build):>8} bytes  CRLF={raw_build.count(CRLF)}",
        f"      committed {len(raw_committed):>8} bytes  CRLF={raw_committed.count(CRLF)}",
    ]
    try:
        text_build = raw_build.decode("utf-8").replace("\r\n", "\n").splitlines()
        text_committed = raw_committed.decode("utf-8").replace("\r\n", "\n").splitlines()
    except UnicodeDecodeError:
        lines.append("      binary file; bytes differ")
        return lines
    for number, (left, right) in enumerate(zip(text_build, text_committed), start=1):
        if left != right:
            lines.append(f"      first differing line {number}:")
            lines.append(f"        built     | {left[:160]}")
            lines.append(f"        committed | {right[:160]}")
            return lines
    if len(text_build) != len(text_committed):
        lines.append(
            f"      line counts differ: built {len(text_build)}, committed {len(text_committed)}"
        )
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify backend/static matches a fresh frontend/dist build."
    )
    parser.parse_args(argv)

    problems = compare()
    if problems:
        print("[static-sync] backend/static does not match the fresh frontend build:")
        for problem in problems:
            print(problem)
        print(
            "\n[static-sync] The committed UI bundle is stale. Rebuild and re-sync:\n"
            "    cd frontend && npm run build\n"
            "    python -c \"import shutil,pathlib; d=pathlib.Path('backend/static');"
            " shutil.rmtree(d, ignore_errors=True);"
            " shutil.copytree('frontend/dist', d)\"\n"
            "    python scripts/measure_bundle.py"
        )
        return 1

    print(f"[static-sync] backend/static matches frontend/dist ({len(_relative_files(BUILD))} files).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
