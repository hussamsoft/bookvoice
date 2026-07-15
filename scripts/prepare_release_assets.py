#!/usr/bin/env python3
"""Create the checksummed GitHub Release asset manifest and setup bootstrapper."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "installer"
MAX_RELEASE_ASSET = 2 * 1024 * 1024 * 1024


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def build_manifest() -> dict:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    products = {"user": "BookVoice-User.msi", "machine": "BookVoice.msi"}
    cabinets = sorted(INSTALLER.glob("cab[0-9]*.cab"), key=lambda p: int(p.stem[3:]))
    required = [INSTALLER / name for name in products.values()] + cabinets
    missing = [str(path) for path in required if not path.is_file() or path.stat().st_size == 0]
    if missing or not cabinets:
        raise SystemExit("Release assets are incomplete: " + ", ".join(missing or ["no cabinets"]))
    oversized = [path.name for path in required if path.stat().st_size >= MAX_RELEASE_ASSET]
    if oversized:
        raise SystemExit("GitHub release asset exceeds 2 GiB: " + ", ".join(oversized))
    assets = {
        path.name: {"size": path.stat().st_size, "sha256": digest(path)}
        for path in required
    }
    return {
        "schemaVersion": 1,
        "version": version,
        "tag": f"v{version}",
        "repository": "hussamsoft/bookvoice",
        "products": {
            key: {"msi": name, "cabinets": [path.name for path in cabinets]}
            for key, name in products.items()
        },
        "assets": assets,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-bootstrapper", action="store_true")
    args = parser.parse_args()
    manifest = build_manifest()
    manifest_path = INSTALLER / "release-assets.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    sums = "".join(f"{meta['sha256']}  {name}\n" for name, meta in manifest["assets"].items())
    (INSTALLER / "SHA256SUMS.txt").write_text(sums, encoding="ascii")
    if args.build_bootstrapper:
        out = ROOT / "build" / "setup-bootstrapper"
        subprocess.run([
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
            "--name", "BookVoice-Setup", f"--distpath={out / 'dist'}",
            f"--workpath={out / 'work'}", f"--specpath={out}",
            str(ROOT / "scripts" / "setup_bootstrapper.py"),
        ], cwd=ROOT, check=True)
        shutil.copy2(out / "dist" / "BookVoice-Setup.exe", INSTALLER / "BookVoice-Setup.exe")
    print(f"[release] prepared {len(manifest['assets'])} payload assets for {manifest['tag']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
