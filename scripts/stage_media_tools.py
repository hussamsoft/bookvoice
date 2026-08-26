"""Stage pinned FFmpeg tools and record their release provenance."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


MEDIA_SOURCE_ENV = "BOOKVOICE_MEDIA_TOOLS_SOURCE"
PINNED_VERSION = "8.1.1"
TOOL_DIR = Path("tools") / "ffmpeg"
TOOL_NAMES = ("ffmpeg.exe", "ffprobe.exe")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolved_executable(value: str | None) -> Path | None:
    if not value:
        return None
    path = Path(value)
    try:
        resolved = path.resolve(strict=True)
    except OSError:
        return None
    return resolved if resolved.is_file() else None


def media_tools_source(extra_dir: Path | None = None) -> dict[str, Path]:
    """Resolve build-machine tools; packaged runtime never calls this function."""
    configured = os.environ.get(MEDIA_SOURCE_ENV, "").strip()
    if configured:
        directory = Path(configured).resolve()
        candidates = {name: _resolved_executable(str(directory / name)) for name in TOOL_NAMES}
    else:
        candidates = {name: _resolved_executable(shutil.which(name)) for name in TOOL_NAMES}
    missing = [name for name, path in candidates.items() if path is None]
    if missing and extra_dir is not None:
        # A previous build's dist payload already carries the pinned binaries;
        # rebuilding must not require an external download or env var.
        candidates.update(
            {name: _resolved_executable(str(extra_dir / name)) for name in missing}
        )
        missing = [name for name, path in candidates.items() if path is None]
    if missing:
        raise SystemExit(
            "Pinned FFmpeg tools are required to build BookVoice. Set "
            f"{MEDIA_SOURCE_ENV} to a directory containing " + ", ".join(TOOL_NAMES) + "."
        )
    return {name: path for name, path in candidates.items() if path is not None}


def _tool_version(path: Path, expected_name: str) -> str:
    completed = subprocess.run(
        [str(path), "-version"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
        shell=False,
        creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
    )
    first_line = (completed.stdout or completed.stderr).splitlines()[0] if (completed.stdout or completed.stderr) else ""
    match = re.match(rf"^{re.escape(expected_name)} version ([0-9]+\.[0-9]+\.[0-9]+)(?:[-\s]|$)", first_line)
    if completed.returncode != 0 or not match:
        raise SystemExit(f"Could not verify {expected_name} release version.")
    version = match.group(1)
    if version != PINNED_VERSION:
        raise SystemExit(f"{expected_name} {PINNED_VERSION} is required; found {version}.")
    return version


def _license_path(source: Path) -> Path:
    for base in (source.parent, source.parent.parent):
        for candidate in (base / "LICENSE", base / "LICENSE.txt"):
            if candidate.is_file():
                return candidate
    raise SystemExit("FFmpeg LICENSE file is required beside the pinned build payload.")


def _write_json_atomic(path: Path, payload: dict) -> None:
    fd, name = tempfile.mkstemp(prefix=f".{path.name}-", suffix=".tmp", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _update_manifest(path: Path, media_contract: dict) -> None:
    if not path.is_file():
        raise SystemExit(f"Release manifest missing before media staging: {path.name}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Release manifest is invalid: {path.name}") from exc
    payload["media_tools"] = media_contract
    _write_json_atomic(path, payload)


def stage_media_tools(root: Path, dist: Path) -> dict:
    sources = media_tools_source(dist / TOOL_DIR)
    versions = {
        name: _tool_version(path, Path(name).stem)
        for name, path in sources.items()
    }
    if set(versions.values()) != {PINNED_VERSION}:
        raise SystemExit("FFmpeg and FFprobe versions do not match.")

    # Sources may resolve from a previous build's dist payload — the same
    # directory this step replaces. Copy them aside before the wipe.
    staging_dir = Path(tempfile.mkdtemp(prefix="bookvoice-media-tools-"))
    try:
        for name in TOOL_NAMES:
            shutil.copy2(sources[name], staging_dir / name)
        # Resolve the license while the originals still exist.
        shutil.copy2(_license_path(sources["ffmpeg.exe"]), staging_dir / "LICENSE.txt")
        destination = dist / TOOL_DIR
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir(parents=True)
        for name in TOOL_NAMES:
            shutil.copy2(staging_dir / name, destination / name)
        shutil.copy2(staging_dir / "LICENSE.txt", destination / "LICENSE.txt")
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)

    notice = root / "third_party" / "FFmpeg-NOTICE.txt"
    if not notice.is_file():
        raise SystemExit("third_party/FFmpeg-NOTICE.txt is required.")
    shutil.copy2(notice, destination / "NOTICE.txt")

    contract = {
        "version": PINNED_VERSION,
        "provider": "Gyan FFmpeg full build",
        "ffmpeg": (TOOL_DIR / "ffmpeg.exe").as_posix(),
        "ffprobe": (TOOL_DIR / "ffprobe.exe").as_posix(),
        "notice": (TOOL_DIR / "NOTICE.txt").as_posix(),
        "license": (TOOL_DIR / "LICENSE.txt").as_posix(),
        "sha256": {
            "ffmpeg": _sha256(destination / "ffmpeg.exe"),
            "ffprobe": _sha256(destination / "ffprobe.exe"),
        },
    }
    _update_manifest(dist / "runtime-manifest.json", contract)
    _update_manifest(dist / "release-manifest.json", contract)
    return contract
