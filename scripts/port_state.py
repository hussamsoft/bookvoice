"""Shared sticky-port state for the BookVoice launchers.

Both ``launch.py`` (the desktop launcher) and ``serve_bookvoice.py``
(the headless server console) start a uvicorn process and want the
server to come up on the same port it last used successfully —
without breaking the user when that port is busy.

The previous design (audit finding C-30) split this logic across
two entry points: only ``serve_bookvoice.py`` read or wrote the
``server-port.json`` sticky file; ``launch.py`` always scanned.
That meant a user who alternated between ``BookVoice.exe`` (browser
mode) and ``Start-BookVoice-Server.bat`` (LAN mode) saw their port
change even when the previous port was still free.

This module is the single source of truth. Both launchers call
``load_preferred_port`` at startup and ``save_preferred_port`` once
uvicorn is ready.
"""
from __future__ import annotations

import json
import os
import socket
from pathlib import Path


PORT_FILE_NAME = "server-port.json"


def port_file_path(runtime_dir: str | os.PathLike[str]) -> Path:
    """Where the sticky-port file lives for a given runtime dir."""
    return Path(runtime_dir) / PORT_FILE_NAME


def load_preferred_port(runtime_dir: str | os.PathLike[str]) -> int:
    """The port this install last came up ready on, if it is plausible.

    Returns 0 if the file is missing, malformed, or holds an
    out-of-range value.
    """
    try:
        with open(port_file_path(runtime_dir), encoding="utf-8") as handle:
            port = int(json.load(handle).get("port") or 0)
    except (OSError, ValueError, json.JSONDecodeError):
        return 0
    return port if 1 <= port <= 65535 else 0


def save_preferred_port(
    runtime_dir: str | os.PathLike[str],
    port: int,
) -> None:
    """Persist ``port`` as the install's preferred port.

    Atomic write via tempfile + os.replace. Best-effort: if the
    runtime dir is read-only or full, the failure is silent so the
    launcher can still bring up the server.
    """
    if not (1 <= int(port) <= 65535):
        return
    path = port_file_path(runtime_dir)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"port": int(port)}, handle)
            handle.write("\n")
        os.replace(tmp, path)
    except OSError:
        pass
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def port_free(host: str, port: int) -> bool:
    """True if the OS would let us bind ``(host, port)`` right now."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False
