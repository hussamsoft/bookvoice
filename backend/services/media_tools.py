"""Safe resolution and invocation of BookVoice's packaged media tools."""
from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable


class MediaToolCancelled(RuntimeError):
    """Raised when a cancellable media operation is stopped."""


def media_tool_path(name: str) -> str:
    executable = f"{name}.exe" if os.name == "nt" else name
    configured = os.environ.get("BOOKVOICE_MEDIA_TOOLS_DIR", "").strip()
    app_dir = Path(os.environ.get("APP_DIR", os.getcwd()))
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured) / executable)
    candidates.extend(
        [
            app_dir / "tools" / "ffmpeg" / executable,
            Path(__file__).resolve().parents[2]
            / "dist"
            / "tools"
            / "ffmpeg"
            / executable,
        ]
    )
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.resolve())
    if (app_dir / "runtime-manifest.json").is_file():
        raise RuntimeError(f"Packaged media tool is missing: {executable}.")
    system = shutil.which(executable) or shutil.which(name)
    if system:
        return system
    raise RuntimeError(f"{name} is unavailable. Reinstall BookVoice to restore media tools.")


def redact_media_error(message: str) -> str:
    text = str(message or "").replace("\r", " ").replace("\n", " ")
    for root in (os.environ.get("DATA_DIR", ""), os.environ.get("USERPROFILE", "")):
        if root:
            text = text.replace(root, "<local-data>")
    return " ".join(text.split())[-600:]


def run_media_tool(
    name: str,
    args: list[str],
    timeout: int = 300,
    *,
    cancel_check: Callable[[], bool] | None = None,
) -> str:
    command = [media_tool_path(name), *[str(arg) for arg in args]]
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
        creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
    )
    deadline = time.monotonic() + max(1, int(timeout))
    while True:
        try:
            stdout, stderr = process.communicate(timeout=0.2)
            break
        except subprocess.TimeoutExpired:
            if cancel_check and cancel_check():
                process.terminate()
                try:
                    process.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                raise MediaToolCancelled(f"{name} was cancelled.")
            if time.monotonic() >= deadline:
                process.kill()
                process.communicate()
                raise RuntimeError(f"{name} timed out while processing local media.")
    if process.returncode != 0:
        detail = redact_media_error(stderr or stdout)
        raise ValueError(f"Media processing failed. {detail}".strip())
    return stdout
