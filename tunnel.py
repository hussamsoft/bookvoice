#!/usr/bin/env python3
"""Cloudflare Tunnel management for BookVoice.

Publishes the local backend over HTTPS without opening a router port. Two modes:

* **Named tunnel** — a tunnel you created once against a domain on your
  Cloudflare account. The hostname is permanent: it survives reboots, closing
  and reopening the app, a new LAN address, and the backend landing on a
  different local port. This is the mode to use.
* **Quick tunnel** — no account or domain needed, but Cloudflare issues a fresh
  random ``*.trycloudflare.com`` hostname on *every* start. Useful for a one-off;
  useless as a bookmark.

Settings are persisted next to the app's other runtime state, so the same
hostname comes back on the next launch without being re-entered.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

SETTINGS_FILE = "tunnel.json"
QUICK_URL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.IGNORECASE)
QUICK_URL_TIMEOUT_S = 60
_TRUTHY = {"1", "true", "yes", "on"}


class TunnelError(RuntimeError):
    """Raised when a tunnel is requested but cannot be established."""


def settings_path(runtime_dir: str) -> Path:
    return Path(runtime_dir) / SETTINGS_FILE


def load_settings(runtime_dir: str) -> dict:
    """Read persisted tunnel settings; an unreadable file is treated as absent."""
    try:
        loaded = json.loads(settings_path(runtime_dir).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def save_settings(runtime_dir: str, settings: dict) -> None:
    target = settings_path(runtime_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(".json.tmp")
    try:
        temp.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
        os.replace(temp, target)
    except OSError:
        temp.unlink(missing_ok=True)


def resolve_settings(runtime_dir: str, overrides: dict | None = None) -> dict:
    """Merge persisted settings with environment and command-line overrides.

    Precedence is explicit argument, then environment, then whatever was stored
    last. Anything supplied is written back, so a hostname has to be given once.
    """
    stored = load_settings(runtime_dir)
    supplied = {key: value for key, value in (overrides or {}).items() if value}

    def pick(key: str, env_name: str):
        if supplied.get(key):
            return supplied[key]
        from_env = str(os.environ.get(env_name, "") or "").strip()
        if from_env:
            return from_env
        return stored.get(key) or ""

    settings = {
        "mode": (pick("mode", "BOOKVOICE_TUNNEL") or "").lower(),
        "hostname": pick("hostname", "BOOKVOICE_TUNNEL_HOSTNAME"),
        "name": pick("name", "BOOKVOICE_TUNNEL_NAME"),
        "token": pick("token", "BOOKVOICE_TUNNEL_TOKEN"),
        "config": pick("config", "BOOKVOICE_TUNNEL_CONFIG"),
        "binary": pick("binary", "BOOKVOICE_CLOUDFLARED"),
    }
    if settings["mode"] in _TRUTHY:
        settings["mode"] = "cloudflare"
    # A hostname, tunnel name or token on its own is an unambiguous request.
    if not settings["mode"] and (settings["hostname"] or settings["name"] or settings["token"]):
        settings["mode"] = "cloudflare"
    return settings


def is_enabled(settings: dict) -> bool:
    return str(settings.get("mode") or "").lower() in {"cloudflare", "cloudflared", "quick"}


def is_remote_managed(settings: dict) -> bool:
    """A dashboard tunnel run from a token.

    Cloudflare serves the ingress rules for these, so the local port comes from
    the dashboard's public hostname entry and ``--url`` is ignored. The port the
    app listens on therefore has to be pinned to match.
    """
    return bool(settings.get("token"))


def is_named(settings: dict) -> bool:
    """True when the public address will not change between runs.

    Either a locally-created named tunnel with a routed hostname, or a
    dashboard tunnel whose hostname is configured in Cloudflare.
    """
    if is_remote_managed(settings):
        return True
    return bool(settings.get("name") and settings.get("hostname"))


def find_cloudflared(explicit: str = "") -> str:
    """Locate cloudflared, preferring an explicit path, then the app, then PATH."""
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    app_dir = Path(os.environ.get("APP_DIR", os.getcwd()))
    executable = "cloudflared.exe" if os.name == "nt" else "cloudflared"
    candidates.extend([
        app_dir / "tools" / "cloudflared" / executable,
        app_dir / executable,
    ])
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.resolve())
    found = shutil.which("cloudflared") or shutil.which(executable)
    if found:
        return found
    raise TunnelError(
        "cloudflared was not found. Install it from "
        "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ "
        "or set BOOKVOICE_CLOUDFLARED to its full path."
    )


def build_command(settings: dict, port: int, binary: str) -> list[str]:
    """Build the cloudflared invocation for this run.

    For locally-managed tunnels the port is passed on the command line rather
    than baked into config.yml, because the launcher picks a free port and it
    will not always be the same one.

    A dashboard tunnel takes its ingress from Cloudflare and ignores ``--url``
    and ``--config`` entirely, so neither is sent — the port must instead be
    pinned to whatever the dashboard's public hostname points at.
    """
    command = [binary, "tunnel", "--no-autoupdate"]
    if is_remote_managed(settings):
        return command + ["run", "--token", str(settings["token"])]
    if settings.get("config"):
        command += ["--config", str(settings["config"])]
    command += ["--url", f"http://127.0.0.1:{int(port)}"]
    if settings.get("name"):
        command += ["run", str(settings["name"])]
    return command


def redact_command(command: list[str]) -> str:
    """Render a command for the log with any tunnel token removed.

    The token carries account credentials, and the launcher log is a plain file
    people paste into bug reports.
    """
    parts = []
    redact_next = False
    for part in command:
        if redact_next:
            parts.append("<token>")
            redact_next = False
            continue
        parts.append(part)
        redact_next = part == "--token"
    return " ".join(parts)


def public_origin(settings: dict) -> str:
    hostname = str(settings.get("hostname") or "").strip()
    if not hostname:
        return ""
    if hostname.startswith(("http://", "https://")):
        return hostname.rstrip("/")
    return f"https://{hostname}"


class CloudflareTunnel:
    """A cloudflared child process tied to the lifetime of the app."""

    def __init__(self, settings: dict, port: int, log=None):
        self.settings = dict(settings)
        self.port = int(port)
        self.log = log
        self.process: subprocess.Popen | None = None
        self.url = public_origin(settings)
        self._quick_url_seen = threading.Event()

    def _write(self, message: str) -> None:
        if self.log is not None:
            try:
                self.log.write(message)
            except Exception:  # noqa: BLE001 - logging must never break startup
                pass

    def start(self) -> str:
        binary = find_cloudflared(self.settings.get("binary", ""))
        command = build_command(self.settings, self.port, binary)
        self._write(f"tunnel: {redact_command(command)}")
        creation = 0
        if os.name == "nt":
            creation = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            self.process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creation,
            )
        except OSError as exc:
            raise TunnelError(f"cloudflared could not be started: {exc}") from exc

        threading.Thread(target=self._drain_output, name="cloudflared-log", daemon=True).start()
        if not self.url and not is_remote_managed(self.settings):
            # Quick tunnel: the hostname only exists once Cloudflare announces it.
            # A dashboard tunnel never prints one — its hostname lives in
            # Cloudflare, so it has to be supplied as --tunnel-hostname.
            if not self._quick_url_seen.wait(QUICK_URL_TIMEOUT_S):
                self.stop()
                raise TunnelError("cloudflared did not report a tunnel URL in time.")
        return self.url

    def _drain_output(self) -> None:
        stream = self.process.stdout if self.process else None
        if stream is None:
            return
        for line in stream:
            text = line.rstrip()
            if text:
                self._write(f"cloudflared: {text}")
            if not self.url:
                match = QUICK_URL_PATTERN.search(text)
                if match:
                    self.url = match.group(0)
                    self._quick_url_seen.set()

    def stop(self) -> None:
        process, self.process = self.process, None
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except Exception:  # noqa: BLE001 - a stuck tunnel must not block shutdown
            try:
                process.kill()
            except Exception:
                pass


def start_tunnel(settings: dict, port: int, runtime_dir: str, log=None) -> CloudflareTunnel:
    """Start a tunnel and persist the settings that produced it."""
    tunnel = CloudflareTunnel(settings, port, log=log)
    tunnel.start()
    persisted = {key: value for key, value in settings.items() if value}
    persisted["lastUrl"] = tunnel.url
    persisted["lastStartedAt"] = time.time()
    save_settings(runtime_dir, persisted)
    return tunnel


def missing_hostname_warning(settings: dict) -> str:
    """Explain the one way a dashboard tunnel is left half-configured."""
    if is_remote_managed(settings) and not settings.get("hostname"):
        return (
            "The tunnel is running, but no --tunnel-hostname was given. BookVoice "
            "cannot trust requests from a hostname it does not know, so the browser "
            "will be refused. Pass the public hostname you routed in the Cloudflare "
            "dashboard."
        )
    return ""
