"""Stage BookVoice's prebuilt Python worker runtime into a release payload."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path


RUNTIME_SOURCE_ENV = "BOOKVOICE_RUNTIME_SOURCE"
REQUIRED_PACKAGES = (
    "fastapi",
    "uvicorn",
    "chatterbox",
    "torch",
    "torchaudio",
    "transformers",
    "deep_translator",
    "easyocr",
    "PIL",
    "numpy",
    "cv2",
    "soundfile",
    "librosa",
)
WORKER_RELATIVE_PATH = Path("runtime") / "worker"


def _import_target_exists(packages: Path, name: str) -> bool:
    return (packages / name).is_dir() or (packages / f"{name}.py").is_file()


def _site_packages_are_ready(packages: Path) -> bool:
    return all(_import_target_exists(packages, package) for package in REQUIRED_PACKAGES)


def runtime_bundle_is_ready(root: Path) -> bool:
    """Return whether *root* is a runnable, prebuilt worker environment."""
    if not (root / "python.exe").is_file():
        return False
    if not (root / "python310.dll").is_file():
        return False
    return _site_packages_are_ready(root / "Lib" / "site-packages")


def runtime_source_is_ready(root: Path) -> bool:
    if not (root / "Scripts" / "python.exe").is_file():
        return False
    return _site_packages_are_ready(root / "Lib" / "site-packages")


def runtime_source(root: Path) -> Path:
    """Resolve the release worker source without relying on an end-user machine."""
    configured = os.environ.get(RUNTIME_SOURCE_ENV, "").strip()
    candidates = [Path(configured)] if configured else []
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    if local_app_data:
        candidates.append(Path(local_app_data) / "BookVoice" / ".venv")
    candidates.append(root / "test_venv_310")
    for candidate in candidates:
        if runtime_source_is_ready(candidate):
            return candidate
    raise SystemExit(
        "A prebuilt BookVoice runtime is required. Set "
        f"{RUNTIME_SOURCE_ENV} to a Python 3.10 environment containing "
        + ", ".join(REQUIRED_PACKAGES)
        + "."
    )


def write_runtime_manifest(dist: Path, version: str) -> dict[str, object]:
    """Write the runtime contract the launcher and package validation depend on."""
    manifest = {
        "schema_version": 1,
        "app_version": version,
        "worker_python": "runtime/worker/python.exe",
        "startup_provisioning": "forbidden",
        "required_packages": list(REQUIRED_PACKAGES),
    }
    path = dist / "runtime-manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def _copy_runtime(source: Path, base_runtime: Path, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(base_runtime, destination)
    shutil.copytree(
        source / "Lib" / "site-packages",
        destination / "Lib" / "site-packages",
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "pip", "pip.exe"),
    )


def stage_runtime_bundle(root: Path, dist: Path, version: str) -> Path:
    source = runtime_source(root)
    destination = dist / WORKER_RELATIVE_PATH
    base_runtime = dist / "runtime" / "python"
    if not (base_runtime / "python.exe").is_file():
        raise SystemExit("Embeddable Python must be staged before the worker runtime.")
    _copy_runtime(source, base_runtime, destination)
    if not runtime_bundle_is_ready(destination):
        raise SystemExit(f"Staged worker runtime is incomplete: {destination}")
    shutil.rmtree(base_runtime)
    write_runtime_manifest(dist, version)
    return destination
