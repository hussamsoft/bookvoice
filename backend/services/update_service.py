"""Find, stage and hand off a BookVoice update.

Until now nothing checked for updates. ``launcher_app.main()`` spawns the app
and returns as soon as ``discover_install()`` finds an install, and
``setup_bootstrapper``'s manifest URL is pinned to the version frozen into the
executable, so an installed copy could never learn that a newer release
existed. 2.6.0 and 2.6.1 shipped a broken launcher and a stale UI to people who
had no way to find out.

The division of labour here is deliberate: this module only *finds* the update
and downloads one small, checksum-verified file --
``BookVoice-Launcher.exe``. Everything hard about installing (resumable
downloads of the MSI and its cabinets, checksum enforcement, disk-space
planning, msiexec, elevation) already exists inside that executable and is the
same code path a fresh install uses. A launcher built for tag *vN* pins itself
to *vN*, so the downloaded one validates the new release's manifest without
this module having to weaken ``validate_manifest``.

SIGNING: the MSI and both executables are unsigned (``Launcher.spec`` sets
``codesign_identity=None`` and nothing runs signtool). The handoff below
therefore ends in a SmartScreen warning and an unsigned UAC prompt for
machine-scope installs. That is a real weakness of this flow, not a formality:
a user trained to approve it is a user who will approve the next one. Signing
the MSI removes it and changes nothing else here.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from services.access_service import server_mode
from services.config_service import app_version, get_config

REPOSITORY = "hussamsoft/bookvoice"
LATEST_RELEASE_API = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
RELEASES_URL = f"https://github.com/{REPOSITORY}/releases"
LAUNCHER_ASSET = "BookVoice-Launcher.exe"

# Re-check at most once a day. The check is an outbound request that tells
# GitHub an install exists, so it stays cheap, cached, and switchable off.
CHECK_TTL_SECONDS = 24 * 60 * 60
NETWORK_TIMEOUT = 15

# launch.py's watchdog restarts a backend that exits (uvicorn's proactor accept
# loop can die silently, so a bare exit means "crashed"). This code means "I
# exited on purpose to be replaced" -- without it the watchdog would restart
# the app underneath msiexec and fight it for open files.
UPDATE_EXIT_CODE = 86

# Guards the staged-download bookkeeping below, not the download itself.
_lock = threading.Lock()
_download: dict = {"state": "idle"}


def _data_dir() -> Path:
    return Path(os.environ.get("DATA_DIR", "data"))


def _cache_path() -> Path:
    return _data_dir() / "update-check.json"


def _updates_dir() -> Path:
    return _data_dir() / "updates"


def pending_path() -> Path:
    """Sentinel launch.py reads after an UPDATE_EXIT_CODE exit."""
    return _data_dir() / "update-pending.json"


def parse_version(text: str | None) -> tuple[int, ...] | None:
    """Parse "2.6.3" or "v2.6.3" into (2, 6, 3); None when it is not a release.

    Returning None for anything unparseable -- "dev" in a source checkout, a
    tag with a suffix -- is what keeps a dev run from ever being told it is out
    of date, and keeps a malformed tag from being treated as newer.
    """
    raw = str(text or "").strip().lstrip("vV")
    if not raw:
        return None
    parts = raw.split(".")
    if not all(part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def is_newer(latest: str | None, current: str | None) -> bool:
    left, right = parse_version(latest), parse_version(current)
    if left is None or right is None:
        return False
    return left > right


def supported() -> bool:
    """True where an update can actually be installed.

    Hosted deployments are excluded on purpose: the person looking at the UI is
    not on the machine that would need restarting, and whoever runs the server
    manages its version themselves.
    """
    return os.name == "nt" and not server_mode()


def enabled() -> bool:
    return bool(get_config().get("check_for_updates", True))


def _read_cache() -> dict:
    try:
        raw = json.loads(_cache_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _write_cache(payload: dict) -> None:
    try:
        path = _cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        pass  # A cache we cannot write costs a request, not correctness.


def _fetch_latest_tag() -> str:
    request = urllib.request.Request(
        LATEST_RELEASE_API,
        headers={
            # GitHub rejects requests without a User-Agent.
            "User-Agent": f"BookVoice/{app_version()}",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(request, timeout=NETWORK_TIMEOUT) as response:
        payload = json.load(response)
    tag = str(payload.get("tag_name") or "").strip()
    if not tag:
        raise RuntimeError("The GitHub release response carried no tag.")
    return tag


def check(force: bool = False) -> dict:
    """Report the newest release, from cache unless it is stale or forced.

    Never raises. A machine that is offline, rate-limited or behind a proxy
    gets ``error`` set and ``updateAvailable`` false -- an update check is not
    worth interrupting someone's reading over.
    """
    current = app_version()
    result = {
        "current": current,
        "latest": None,
        "updateAvailable": False,
        "supported": supported(),
        "enabled": enabled(),
        "releaseUrl": RELEASES_URL,
        "checkedAt": None,
        "error": None,
        "download": download_status(),
    }
    if not result["supported"] or not result["enabled"]:
        return result

    cached = _read_cache()
    fresh = (
        not force
        and isinstance(cached.get("checkedAt"), (int, float))
        and (time.time() - cached["checkedAt"]) < CHECK_TTL_SECONDS
        and cached.get("latest")
    )
    if fresh:
        latest, checked_at = cached["latest"], cached["checkedAt"]
    else:
        try:
            latest = _fetch_latest_tag().lstrip("vV")
            checked_at = time.time()
            _write_cache({"latest": latest, "checkedAt": checked_at})
        except (OSError, urllib.error.URLError, ValueError, RuntimeError) as exc:
            # Fall back to a stale cache rather than showing nothing: knowing
            # about yesterday's release beats knowing about none.
            if cached.get("latest"):
                latest, checked_at = cached["latest"], cached.get("checkedAt")
                result["error"] = f"Could not reach GitHub; showing the last known release. ({exc})"
            else:
                result["error"] = f"Could not check for updates. ({exc})"
                return result

    result["latest"] = latest
    result["checkedAt"] = checked_at
    result["updateAvailable"] = is_newer(latest, current)
    if result["updateAvailable"]:
        result["releaseUrl"] = f"{RELEASES_URL}/tag/v{latest}"
        result["staged"] = staged_installer(latest) is not None
    return result


def _sha256(path: Path) -> str:
    import hashlib

    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def staged_installer(version: str) -> Path | None:
    """The already-downloaded installer for ``version``, if it is intact."""
    candidate = _updates_dir() / version / LAUNCHER_ASSET
    if candidate.is_file() and candidate.stat().st_size > 0:
        return candidate
    return None


def _fetch_manifest(tag: str) -> dict:
    url = f"{RELEASES_URL}/download/{tag}/release-assets.json"
    with urllib.request.urlopen(url, timeout=NETWORK_TIMEOUT) as response:
        manifest = json.load(response)
    if not isinstance(manifest, dict):
        raise RuntimeError("The release manifest was not an object.")
    # Same trust rules setup_bootstrapper.validate_manifest applies, but
    # against the version being fetched instead of the one frozen into this
    # build -- that pin is what makes an installed copy unable to see a newer
    # release in the first place.
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("repository") != REPOSITORY
        or manifest.get("tag") != tag
        or f"v{manifest.get('version')}" != tag
    ):
        raise RuntimeError("The BookVoice release manifest is not trusted.")
    return manifest


def download_status() -> dict:
    with _lock:
        return dict(_download)


def _set_status(**fields) -> None:
    with _lock:
        _download.update(fields)


def download_installer(version: str, *, tag: str | None = None) -> Path:
    """Download and checksum-verify the installer for ``version``.

    Only ``BookVoice-Launcher.exe`` is fetched here. It is a listed asset in
    ``release-assets.json`` -- never one of ``products.*.cabinets``, so it is
    checksummed without the launcher being asked to download itself.
    """
    tag = tag or f"v{version}"
    existing = staged_installer(version)
    manifest = _fetch_manifest(tag)
    expected = (manifest.get("assets") or {}).get(LAUNCHER_ASSET)
    if not isinstance(expected, dict) or "sha256" not in expected or "size" not in expected:
        raise RuntimeError(f"Release {tag} does not publish {LAUNCHER_ASSET}.")

    target = _updates_dir() / version / LAUNCHER_ASSET
    if existing and existing.stat().st_size == int(expected["size"]) and _sha256(existing) == expected["sha256"]:
        _set_status(state="ready", version=version, received=int(expected["size"]), total=int(expected["size"]), error=None)
        return existing

    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".part")
    total = int(expected["size"])
    _set_status(state="downloading", version=version, received=0, total=total, error=None)

    url = f"{RELEASES_URL}/download/{tag}/{LAUNCHER_ASSET}"
    received = 0
    with urllib.request.urlopen(url, timeout=NETWORK_TIMEOUT) as response, partial.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
            received += len(chunk)
            _set_status(received=received)

    if partial.stat().st_size != total or _sha256(partial) != expected["sha256"]:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Checksum verification failed for {LAUNCHER_ASSET}.")
    os.replace(partial, target)
    _set_status(state="ready", received=total, total=total, error=None)
    return target


def start_download(version: str) -> dict:
    """Download in the background so the request returns immediately."""
    with _lock:
        if _download.get("state") == "downloading":
            return dict(_download)
        _download.clear()
        _download.update({"state": "downloading", "version": version, "received": 0, "total": 0, "error": None})

    def work() -> None:
        try:
            download_installer(version)
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI, never raised into the thread
            _set_status(state="failed", error=str(exc))

    threading.Thread(target=work, daemon=True, name="bookvoice-update-download").start()
    return download_status()


def begin_install(version: str, *, exit_delay: float = 1.5) -> dict:
    """Hand the install to the staged launcher and bow out.

    Writing the sentinel *before* exiting is what separates this from a crash:
    launch.py restarts a backend that dies, so the exit code plus this file are
    the only way it can tell "replace me" from "I fell over".
    """
    if not supported():
        raise RuntimeError("Updates install from the Windows desktop app only.")
    installer = staged_installer(version)
    if installer is None:
        raise FileNotFoundError("The update has not been downloaded yet.")

    payload = {
        "version": version,
        "installer": str(installer),
        "requestedAt": time.time(),
    }
    path = pending_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")

    def quit_for_update() -> None:
        time.sleep(exit_delay)  # let the 202 reach the browser first
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(UPDATE_EXIT_CODE)

    threading.Thread(target=quit_for_update, daemon=True, name="bookvoice-update-exit").start()
    return payload


def consume_pending() -> dict | None:
    """Read and clear the sentinel. Used by launch.py after the app exits."""
    path = pending_path()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    finally:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
    return payload if isinstance(payload, dict) else None


def spawn_installer(payload: dict) -> bool:
    """Start the staged launcher detached, so it outlives the app it replaces.

    ``--reinstall`` matters: without it the launcher finds the existing install
    and simply starts it again (launcher_app.main takes the discover_install
    shortcut), which would relaunch the old version instead of upgrading it.
    """
    installer = Path(str(payload.get("installer") or ""))
    if not installer.is_file():
        return False
    creationflags = 0
    if os.name == "nt":
        creationflags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(
        [str(installer), "--reinstall"],
        cwd=str(installer.parent),
        creationflags=creationflags,
        close_fds=True,
    )
    return True
