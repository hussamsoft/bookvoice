#!/usr/bin/env python3
"""Stage the Windows embeddable Python runtime into dist/runtime/python/."""
from __future__ import annotations

import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

PYTHON_EMBED_VERSION = "3.10.11"
EMBED_ZIP_NAME = f"python-{PYTHON_EMBED_VERSION}-embed-amd64.zip"
EMBED_URL = f"https://www.python.org/ftp/python/{PYTHON_EMBED_VERSION}/{EMBED_ZIP_NAME}"


def embed_cache_dir(root: Path) -> Path:
    return root / "tools" / "python-embed" / f"python-{PYTHON_EMBED_VERSION}-embed-amd64"


def embed_zip_path(root: Path) -> Path:
    return root / "tools" / "python-embed" / EMBED_ZIP_NAME


def ensure_embed_cache(root: Path) -> Path:
    cache = embed_cache_dir(root)
    python_exe = cache / "python.exe"
    site_packages = cache / "Lib" / "site-packages"
    if python_exe.is_file() and not site_packages.exists():
        return cache

    tools_dir = root / "tools" / "python-embed"
    tools_dir.mkdir(parents=True, exist_ok=True)
    zip_path = embed_zip_path(root)
    if not zip_path.is_file():
        print(f"[embed] Downloading {EMBED_URL}")
        urllib.request.urlretrieve(EMBED_URL, zip_path)

    if cache.exists():
        shutil.rmtree(cache)
    cache.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(cache)

    pth_files = list(cache.glob("python*._pth"))
    if not pth_files:
        raise SystemExit(f"[embed] python*._pth missing in {cache}")
    pth = pth_files[0]
    lines = pth.read_text(encoding="utf-8").splitlines()
    patched: list[str] = []
    for line in lines:
        if line.strip().startswith("#import site"):
            patched.append("import site")
        else:
            patched.append(line)
    if "import site" not in patched:
        patched.append("import site")
    pth.write_text("\n".join(patched) + "\n", encoding="utf-8")
    return cache


def stage_embed_python(root: Path, dist: Path) -> None:
    cache = ensure_embed_cache(root)
    target = dist / "runtime" / "python"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(cache, target)
    print(f"[embed] Staged embeddable Python → {target}")


if __name__ == "__main__":
    stage_embed_python(Path(__file__).resolve().parent.parent, Path(sys.argv[1]))
