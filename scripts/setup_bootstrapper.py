#!/usr/bin/env python3
"""Download checksum-verified BookVoice MSI cabinets and start Windows Installer."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

REPOSITORY = "hussamsoft/bookvoice"


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def download(url: str, target: Path, expected: dict) -> None:
    partial = target.with_suffix(target.suffix + ".part")
    received = partial.stat().st_size if partial.exists() else 0
    headers = {"Range": f"bytes={received}-"} if received else {}
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
        if received and response.status != 206:
            received = 0
            partial.unlink(missing_ok=True)
        with partial.open("ab" if received else "wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
    if partial.stat().st_size != int(expected["size"]) or sha256(partial) != expected["sha256"]:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Checksum verification failed for {target.name}")
    os.replace(partial, target)


def main() -> int:
    parser = argparse.ArgumentParser(description="Install BookVoice")
    parser.add_argument("--machine", action="store_true", help="Install for all users (admin required)")
    parser.add_argument("--manifest-url")
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()
    product = "machine" if args.machine else "user"
    manifest_url = args.manifest_url or f"https://github.com/{REPOSITORY}/releases/latest/download/release-assets.json"
    with urllib.request.urlopen(manifest_url, timeout=30) as response:
        manifest = json.load(response)
    if manifest.get("repository") != REPOSITORY or manifest.get("schemaVersion") != 1:
        raise RuntimeError("The BookVoice release manifest is not trusted.")
    base = manifest_url.rsplit("/", 1)[0]
    selected = manifest["products"][product]
    names = [selected["msi"], *selected["cabinets"]]
    required = sum(int(manifest["assets"][name]["size"]) for name in names)
    target = Path(tempfile.gettempdir()) / "BookVoice" / manifest["version"] / product
    target.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(target).free < required + 512 * 1024 * 1024:
        raise RuntimeError("Not enough free disk space for the offline BookVoice runtime.")
    for index, name in enumerate(names, 1):
        path = target / name
        expected = manifest["assets"][name]
        if path.is_file() and path.stat().st_size == expected["size"] and sha256(path) == expected["sha256"]:
            continue
        print(f"Downloading {index}/{len(names)}: {name}", flush=True)
        download(f"{base}/{name}", path, expected)
    if not args.download_only:
        return subprocess.run(["msiexec.exe", "/i", str(target / selected["msi"])], check=False).returncode
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
