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


def build_manifest(*, root: Path = ROOT, installer: Path = INSTALLER) -> dict:
    version = (root / "VERSION").read_text(encoding="utf-8").strip()
    products = {"user": "BookVoice-User.msi", "machine": "BookVoice.msi"}
    cabinets = sorted(installer.glob("cab[0-9]*.cab"), key=lambda p: int(p.stem[3:]))
    required = [installer / name for name in products.values()] + cabinets
    # The standalone launcher rides alongside the payload assets and is
    # validated with them: appended BEFORE the size/missing guards so it can
    # never slip through empty or oversized.
    launcher = installer / "BookVoice-Launcher.exe"
    if launcher.is_file():
        required.append(launcher)
    missing = [str(path) for path in required if not path.is_file() or path.stat().st_size == 0]
    if missing or not cabinets:
        raise SystemExit("Release assets are incomplete: " + ", ".join(missing or ["no cabinets"]))
    oversized = [path.name for path in required if path.stat().st_size >= MAX_RELEASE_ASSET]
    if oversized:
        raise SystemExit("GitHub release asset exceeds 2 GiB: " + ", ".join(oversized))
    # Listed under "assets" (so downloads are checksummed) but never under
    # "products.*.cabinets": the launcher must not try to download itself.
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


def build_launcher(installer: Path) -> Path:
    """Build the standalone launcher/setup executable into the release folder."""
    out = ROOT / "build" / "bookvoice-launcher"
    try:
        subprocess.run(
            [
                sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
                f"--distpath={out / 'dist'}",
                f"--workpath={out / 'work'}",
                str(ROOT / "BookVoiceLauncher.spec"),
            ],
            cwd=ROOT,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"Launcher build failed (PyInstaller exit {exc.returncode}).") from exc
    produced = out / "dist" / "BookVoice-Launcher.exe"
    if not produced.is_file():
        raise SystemExit("Launcher build did not produce BookVoice-Launcher.exe")
    target = installer / "BookVoice-Launcher.exe"
    shutil.copy2(produced, target)
    return target


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--build-launcher",
        action="store_true",
        help="Build BookVoice-Launcher.exe before writing the manifest",
    )
    parser.add_argument(
        "--build-bootstrapper",
        action="store_true",
        help="Deprecated alias for --build-launcher (the two executables merged)",
    )
    args = parser.parse_args()
    if args.build_launcher or args.build_bootstrapper:
        artifact = build_launcher(INSTALLER)
        print(f"[release] built {artifact.name} ({artifact.stat().st_size // 1024} KB)")
    manifest = build_manifest()
    manifest_path = INSTALLER / "release-assets.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    sums = "".join(f"{meta['sha256']}  {name}\n" for name, meta in manifest["assets"].items())
    (INSTALLER / "SHA256SUMS.txt").write_text(sums, encoding="ascii")
    print(f"[release] prepared {len(manifest['assets'])} payload assets for {manifest['tag']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
