#!/usr/bin/env python3
"""Stage the Windows embeddable Python runtime into dist/runtime/python/.

The official embeddable zip omits stdlib ``venv`` / ``ensurepip`` and the
Windows venv script binaries under ``Lib/venv/scripts/nt/``.

We inject those from the matching NuGet ``python`` package so
``runtime\\python\\python.exe -m venv`` works with no system Python.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

PYTHON_EMBED_VERSION = "3.10.11"
EMBED_ZIP_NAME = f"python-{PYTHON_EMBED_VERSION}-embed-amd64.zip"
EMBED_URL = f"https://www.python.org/ftp/python/{PYTHON_EMBED_VERSION}/{EMBED_ZIP_NAME}"
NUGET_URL = f"https://www.nuget.org/api/v2/package/python/{PYTHON_EMBED_VERSION}"
STDLIB_PACKAGES = ("venv", "ensurepip")


def embed_cache_dir(root: Path) -> Path:
    return root / "tools" / "python-embed" / f"python-{PYTHON_EMBED_VERSION}-embed-amd64"


def embed_zip_path(root: Path) -> Path:
    return root / "tools" / "python-embed" / EMBED_ZIP_NAME


def nuget_zip_path(root: Path) -> Path:
    return root / "tools" / "python-embed" / f"python-{PYTHON_EMBED_VERSION}.nupkg"


def embed_is_ready(cache: Path) -> bool:
    if not (cache / "python.exe").is_file():
        return False
    if (cache / "Lib" / "site-packages").exists():
        return False
    if not (cache / "Lib" / "venv" / "__init__.py").is_file():
        return False
    if not (cache / "Lib" / "ensurepip" / "__init__.py").is_file():
        return False
    # Windows venv copies these into the new env's Scripts/ folder.
    return (cache / "Lib" / "venv" / "scripts" / "nt" / "python.exe").is_file()


def _download(url: str, dest: Path) -> None:
    print(f"[embed] Downloading {url}")
    urllib.request.urlretrieve(url, dest)


def _inject_stdlib_from_nuget(root: Path, cache: Path) -> None:
    """Copy Lib/venv and Lib/ensurepip (including Windows script exes) from NuGet."""
    tools_dir = root / "tools" / "python-embed"
    tools_dir.mkdir(parents=True, exist_ok=True)
    nupkg = nuget_zip_path(root)
    if not nupkg.is_file():
        _download(NUGET_URL, nupkg)

    lib_dst = cache / "Lib"
    lib_dst.mkdir(parents=True, exist_ok=True)
    prefix = "tools/Lib/"

    with zipfile.ZipFile(nupkg) as archive:
        for info in archive.infolist():
            name = info.filename.replace("\\", "/")
            if not name.startswith(prefix) or info.is_dir():
                continue
            rel = name[len(prefix) :]
            top = rel.split("/", 1)[0]
            if top not in STDLIB_PACKAGES:
                continue
            if "__pycache__" in rel.split("/"):
                continue
            target = lib_dst / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)

    for pkg in STDLIB_PACKAGES:
        marker = lib_dst / pkg / "__init__.py"
        if not marker.is_file():
            raise SystemExit(f"[embed] failed to inject stdlib package: {pkg}")
    nt_python = lib_dst / "venv" / "scripts" / "nt" / "python.exe"
    if not nt_python.is_file():
        raise SystemExit("[embed] Lib/venv/scripts/nt/python.exe missing from NuGet inject")


def _patch_pth(cache: Path) -> None:
    pth_files = list(cache.glob("python*._pth"))
    if not pth_files:
        raise SystemExit(f"[embed] python*._pth missing in {cache}")
    pth = pth_files[0]
    lines = pth.read_text(encoding="utf-8").splitlines()
    patched: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#import site"):
            patched.append("import site")
        else:
            patched.append(line)
    if "import site" not in patched:
        patched.append("import site")
    if "Lib" not in patched:
        patched.append("Lib")
    pth.write_text("\n".join(patched) + "\n", encoding="utf-8")


def ensure_embed_cache(root: Path) -> Path:
    cache = embed_cache_dir(root)
    if embed_is_ready(cache):
        return cache

    tools_dir = root / "tools" / "python-embed"
    tools_dir.mkdir(parents=True, exist_ok=True)
    zip_path = embed_zip_path(root)
    if not zip_path.is_file():
        _download(EMBED_URL, zip_path)

    if cache.exists():
        shutil.rmtree(cache)
    cache.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(cache)

    _patch_pth(cache)
    _inject_stdlib_from_nuget(root, cache)

    probe = subprocess.run(
        [str(cache / "python.exe"), "-c", "import venv, ensurepip; print('ok')"],
        capture_output=True,
        text=True,
        cwd=str(cache),
    )
    if probe.returncode != 0:
        raise SystemExit(
            "[embed] bundled python cannot import venv/ensurepip:\n"
            + (probe.stderr or probe.stdout or "")
        )
    print("[embed] venv + ensurepip injected and verified")
    return cache


def stage_embed_python(root: Path, dist: Path) -> None:
    cache = ensure_embed_cache(root)
    target = dist / "runtime" / "python"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(cache, target)
    print(f"[embed] Staged embeddable Python -> {target}")


if __name__ == "__main__":
    stage_embed_python(Path(__file__).resolve().parent.parent, Path(sys.argv[1]))
