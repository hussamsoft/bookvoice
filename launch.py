"""
BookVoice desktop launcher.

Starts the FastAPI backend with absolute env vars and a scoped writable runtime,
then opens a native window or the default browser.

MSI installs (Program Files or LocalAppData) and dev runs all use this logic.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html as html_lib
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path as _Path

# Launcher helpers sit beside this file in both the source tree and dist/.
if str(_Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(_Path(__file__).resolve().parent))
import system_tray
import tunnel

try:
    import psutil
except ImportError:  # pragma: no cover
    psutil = None

try:
    import webview
except ImportError:  # pragma: no cover
    webview = None



APP_NAME = "BookVoice"
PORT_START = 8000
PORT_END = 8020


def get_git_version() -> str:
    """Derive a precise version from git tags and the current commit.

    On a tagged commit this is the tag (e.g. "2.4.0"). On untagged commits it
    is "<tag>-<distance>-g<shortsha>" (e.g. "2.4.0-4-g1f89b40"), with a
    "-dirty" suffix when the working tree has modifications. Falls back to
    the VERSION file when git is unavailable.
    """
    here = _Path(__file__).resolve().parent
    version = "0.0.0"
    version_file = here / "VERSION"
    if version_file.is_file():
        version = version_file.read_text(encoding="utf-8").strip()
    try:
        import subprocess as _sp
        desc = _sp.check_output(
            ["git", "describe", "--tags", "--dirty", "--always"],
            cwd=str(here), stderr=_sp.DEVNULL, text=True,
        ).strip()
        if desc:
            version = desc if not desc.startswith("v") else desc[1:]
    except (OSError, _sp.CalledProcessError, FileNotFoundError):
        pass
    return version


def configure_webview_gpu() -> None:
    """Render the WebView2 shell on the CPU instead of the GPU.

    The Chatterbox TTS model loads ~1 GB onto the same GPU that WebView2 uses
    for hardware-accelerated rendering. While the model warms up, VRAM and GPU
    compute are saturated; a heavy repaint at that moment (e.g. expanding the
    Reading options panel) can tip the display driver into a TDR reset. WebView2
    then loses its graphics device and the window blanks — which reads as the
    app "crashing," even though the backend and page JavaScript are fine (the
    OS logs it as a display LiveKernelEvent, not an application fault).

    Chosen for quality *and* speed, not just stability: this is a PDF/text
    reader, so the GPU buys us nothing we can see or feel. Chromium rasterizes
    glyphs on the CPU in either mode, so text is pixel-identical; the GPU only
    accelerates compositing, and the only frequent repaint here (the narration
    word-highlight loop) is trivial for software compositing. Meanwhile pdf.js
    already rasterizes pages on the CPU. So software rendering costs no visible
    quality and no meaningful speed at reader sizes, while being the only mode
    that is immune to the GPU TDR — a partial measure like disabling only
    compositing keeps a live GPU device in the render path and can still be
    dropped by a driver reset.

    Set BOOKVOICE_ENABLE_GPU=1 to opt back into hardware acceleration; a
    caller-provided WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is left untouched.
    """
    if os.environ.get("BOOKVOICE_ENABLE_GPU") == "1":
        return
    if os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"):
        return
    # --disable-gpu forces software compositing, so no hardware GPU device
    # remains in the render path for a TDR to remove.
    os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--disable-gpu"


def configure_webview_downloads(webview_module) -> None:
    """Allow HTML download links before the embedded WebView starts."""
    webview_module.settings["ALLOW_DOWNLOADS"] = True


def _log_path(runtime_dir: str, app_dir: str) -> str:
    for folder in (runtime_dir, app_dir):
        try:
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, "bookvoice_launch.log")
            with open(path, "a", encoding="utf-8"):
                pass
            return path
        except OSError:
            continue
    return os.path.join(os.path.expanduser("~"), "bookvoice_launch.log")


class Logger:
    def __init__(self, path: str):
        self.path = path

    def write(self, msg: str) -> None:
        line = f"{datetime.now().isoformat(timespec='seconds')} {msg}"
        try:
            with open(self.path, "a", encoding="utf-8", errors="replace") as f:
                f.write(line + "\n")
        except OSError:
            pass
        try:
            print(line, flush=True)
        except Exception:
            pass


def looks_like_app_dir(path: str) -> bool:
    return os.path.isfile(os.path.join(path, "main.py")) and os.path.isdir(
        os.path.join(path, "static")
    )


def resolve_app_dir() -> str:
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        if looks_like_app_dir(exe_dir):
            return exe_dir
        parent = os.path.dirname(exe_dir)
        if looks_like_app_dir(parent):
            return parent
        return exe_dir

    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (
        here,
        os.path.join(here, "dist"),
        os.path.join(os.path.dirname(here), "dist"),
    ):
        candidate = os.path.abspath(candidate)
        if looks_like_app_dir(candidate):
            return candidate
    return here
















def legacy_runtime_dir() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, APP_NAME)


def resolve_runtime_dir(app_dir: str) -> str:
    """Writable runtime scoped per install location + version."""
    if os.environ.get("BOOKVOICE_PORTABLE", "").strip().lower() in ("1", "true", "yes"):
        return os.path.join(app_dir, ".bookvoice")
    version = read_app_version(app_dir)
    scoped = os.path.join(
        legacy_runtime_dir(),
        "installs",
        f"{install_id(app_dir, version)}",
    )
    scoped_dir = os.path.abspath(scoped)
    legacy_dir = os.path.abspath(legacy_runtime_dir())
    if os.path.isdir(scoped_dir) and any(os.scandir(scoped_dir)):
        return scoped_dir
    if not os.path.isdir(legacy_dir):
        return scoped_dir

    os.makedirs(scoped_dir, exist_ok=True)
    for name in (".venv", "data"):
        src = os.path.join(legacy_dir, name)
        dst = os.path.join(scoped_dir, name)
        if not os.path.exists(src) or os.path.exists(dst):
            continue
        try:
            shutil.move(src, dst)
        except OSError:
            pass

    for name in os.listdir(legacy_dir):
        if not name.startswith("bookvoice_") or not name.endswith(".log"):
            continue
        src = os.path.join(legacy_dir, name)
        dst = os.path.join(scoped_dir, name)
        if os.path.isfile(src) and not os.path.exists(dst):
            try:
                shutil.copy2(src, dst)
            except OSError:
                pass
    return scoped_dir

def read_app_version(app_dir: str) -> str:
    """Read the app version, preferring git for precise commit-level versioning.

    In a packaged release this reads the shipped VERSION file. In development
    it falls back to `git describe` so every commit has a traceable version
    (e.g. "2.4.0-4-g1f89b40" or "2.4.0" on a tag).
    """
    version = "0.0.0"
    version_path = os.path.join(app_dir, "VERSION")
    if os.path.isfile(version_path):
        version = _Path(version_path).read_text(encoding="utf-8").strip()
    # Git gives a more precise version when available
    here = _Path(__file__).resolve().parent
    try:
        import subprocess as _sp
        desc = _sp.check_output(
            ["git", "describe", "--tags", "--dirty", "--always"],
            cwd=str(here), stderr=_sp.DEVNULL, text=True,
        ).strip()
        if desc:
            version = desc if not desc.startswith("v") else desc[1:]
    except (OSError, _sp.CalledProcessError, FileNotFoundError):
        pass
    return version


def install_id(app_dir: str, version: str) -> str:
    payload = f"{os.path.normcase(os.path.abspath(app_dir))}|{version.strip()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def validate_package(app_dir: str) -> str | None:
    if not os.path.isfile(os.path.join(app_dir, "main.py")):
        return f"main.py missing in:\n{app_dir}"
    if not os.path.isfile(os.path.join(app_dir, "static", "index.html")):
        return "static/index.html missing — run python build.py"
    if not os.path.isfile(os.path.join(app_dir, "data", "models", "en", "tokenizer.json")):
        return (
            "Bundled English TTS models missing (data/models/en/).\n"
            "Rebuild from full source: python build.py"
        )
    return None


def resolve_voices_dir(app_dir: str, runtime_dir: str) -> str:
    """Return the stable voice library shared by every install on this machine."""
    portable = os.environ.get("BOOKVOICE_PORTABLE", "").strip().lower()
    if portable in ("1", "true", "yes"):
        return os.path.join(runtime_dir, "data", "voices")
    return os.path.join(legacy_runtime_dir(), "voices")


def _sha256_path(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _voice_metadata(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _voice_created_at(wav_path: str, metadata: dict | None) -> float:
    try:
        created = float((metadata or {}).get("createdAt") or 0)
    except (TypeError, ValueError):
        created = 0
    if created > 0:
        return created
    try:
        return os.path.getmtime(wav_path)
    except OSError:
        return 0


def _safe_voice_stem(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "")).strip("_")
    return (cleaned or "recovered_voice")[:96]


def _copy_voice_file(source: str, target: str) -> None:
    os.makedirs(os.path.dirname(target), exist_ok=True)
    temp = os.path.join(
        os.path.dirname(target),
        f".{os.path.basename(target)}-{os.getpid()}.migrating",
    )
    try:
        shutil.copy2(source, temp)
        os.replace(temp, target)
    finally:
        try:
            os.remove(temp)
        except FileNotFoundError:
            pass


def migrate_voice_library(
    app_dir: str,
    runtime_dir: str,
    voices_dir: str,
    log: Logger,
) -> int:
    """Merge install-scoped voice libraries without overwriting same-name voices.

    Older launchers stored voices below an install/version identity. A rebuild
    therefore made the profiles appear deleted even though the WAV files still
    existed. The oldest profile keeps its original id; later, different WAVs
    with that id are retained under a dated id so no recording is discarded.
    """
    destination = os.path.abspath(voices_dir)
    os.makedirs(destination, exist_ok=True)
    marker_path = os.path.join(destination, ".install-library-migration-v1.json")
    marker = _voice_metadata(marker_path) or {}
    seen_profiles = {
        str(value)
        for value in (marker.get("seenProfiles") or [])
        if isinstance(value, str)
    }
    marker_changed = False
    bookvoice_root = legacy_runtime_dir()
    portable = os.environ.get("BOOKVOICE_PORTABLE", "").strip().lower()
    source_dirs = [os.path.join(runtime_dir, "data", "voices")]
    if portable not in ("1", "true", "yes"):
        source_dirs.append(os.path.join(bookvoice_root, "data", "voices"))
        installs_root = os.path.join(bookvoice_root, "installs")
        if os.path.isdir(installs_root):
            for entry in os.scandir(installs_root):
                if entry.is_dir():
                    source_dirs.append(os.path.join(entry.path, "data", "voices"))

    unique_sources = []
    seen_sources = set()
    for source_dir in source_dirs:
        absolute = os.path.abspath(source_dir)
        if absolute == destination or absolute in seen_sources or not os.path.isdir(absolute):
            continue
        seen_sources.add(absolute)
        unique_sources.append(absolute)

    default_names = set()
    defaults_dir = os.path.join(app_dir, "data", "default_voices")
    if os.path.isdir(defaults_dir):
        default_names = {
            os.path.splitext(name)[0].lower()
            for name in os.listdir(defaults_dir)
            if name.lower().endswith(".wav")
        }

    candidates = []
    for source_dir in unique_sources:
        for name in os.listdir(source_dir):
            if not name.lower().endswith(".wav"):
                continue
            wav_path = os.path.join(source_dir, name)
            if not os.path.isfile(wav_path):
                continue
            metadata_path = os.path.splitext(wav_path)[0] + ".json"
            metadata = _voice_metadata(metadata_path)
            candidates.append(
                (
                    _voice_created_at(wav_path, metadata),
                    name.lower(),
                    wav_path,
                    metadata_path if os.path.isfile(metadata_path) else None,
                    metadata,
                )
            )

    migrated = 0
    for created_at, _name_key, wav_path, metadata_path, metadata in sorted(candidates):
        source_stem = _safe_voice_stem(os.path.splitext(os.path.basename(wav_path))[0])
        source_hash = _sha256_path(wav_path)
        source_key = f"{source_stem.lower()}:{source_hash}"
        if source_key in seen_profiles:
            continue
        target_stem = source_stem
        target_wav = os.path.join(destination, f"{target_stem}.wav")

        if os.path.isfile(target_wav):
            if _sha256_path(target_wav) == source_hash:
                target_json = os.path.join(destination, f"{target_stem}.json")
                if metadata_path and not os.path.isfile(target_json):
                    _copy_voice_file(metadata_path, target_json)
                    migrated += 1
                seen_profiles.add(source_key)
                marker_changed = True
                continue
            # Packaged defaults are replaced by the current package, not
            # multiplied into dated variants on every historical install.
            if metadata is None and source_stem.lower() in default_names:
                seen_profiles.add(source_key)
                marker_changed = True
                continue
            date_key = datetime.fromtimestamp(created_at or time.time()).strftime("%Y%m%d")
            base_stem = _safe_voice_stem(f"{source_stem}_{date_key}")
            target_stem = base_stem
            suffix = 2
            while True:
                target_wav = os.path.join(destination, f"{target_stem}.wav")
                if not os.path.isfile(target_wav):
                    break
                if _sha256_path(target_wav) == source_hash:
                    target_wav = ""
                    break
                target_stem = _safe_voice_stem(f"{base_stem}_{suffix}")
                suffix += 1
            if not target_wav:
                seen_profiles.add(source_key)
                marker_changed = True
                continue

        _copy_voice_file(wav_path, target_wav)
        if metadata is not None:
            recovered = dict(metadata)
            original_id = str(recovered.get("id") or source_stem)
            if target_stem != source_stem:
                label = datetime.fromtimestamp(created_at or time.time()).strftime("%b %d, %Y")
                original_name = str(recovered.get("name") or original_id.replace("_", " ").title())
                recovered["name"] = f"{original_name} ({label})"
            recovered["id"] = target_stem
            recovered["referenceSha256"] = source_hash
            target_json = os.path.join(destination, f"{target_stem}.json")
            temp_json = os.path.join(destination, f".{target_stem}-{os.getpid()}.json.tmp")
            try:
                with open(temp_json, "w", encoding="utf-8", newline="\n") as handle:
                    json.dump(recovered, handle, ensure_ascii=False, indent=2)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_json, target_json)
            finally:
                try:
                    os.remove(temp_json)
                except FileNotFoundError:
                    pass
        migrated += 1
        seen_profiles.add(source_key)
        marker_changed = True
        log.write(f"recovered voice {source_stem} -> {target_stem}")
    if marker_changed:
        temp_marker = os.path.join(destination, f".migration-{os.getpid()}.json.tmp")
        try:
            with open(temp_marker, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(
                    {
                        "schemaVersion": 1,
                        "seenProfiles": sorted(seen_profiles),
                    },
                    handle,
                    ensure_ascii=False,
                    indent=2,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_marker, marker_path)
        finally:
            try:
                os.remove(temp_marker)
            except FileNotFoundError:
                pass
    return migrated


def seed_voices(app_dir: str, voices_dir: str) -> None:
    src = os.path.join(app_dir, "data", "default_voices")
    dst = voices_dir
    os.makedirs(dst, exist_ok=True)
    if not os.path.isdir(src):
        return
    for name in os.listdir(src):
        if name.lower().endswith(".wav"):
            s, d = os.path.join(src, name), os.path.join(dst, name)
            if not os.path.exists(d):
                try:
                    shutil.copy2(s, d)
                except OSError:
                    pass


def clear_pycache(app_dir: str) -> None:
    for root, dirs, _files in os.walk(app_dir):
        if "__pycache__" in dirs:
            path = os.path.join(root, "__pycache__")
            shutil.rmtree(path, ignore_errors=True)
            dirs.remove("__pycache__")


def bundled_python(app_dir: str) -> str | None:
    candidate = os.path.join(app_dir, "runtime", "python", "python.exe")
    return candidate if os.path.isfile(candidate) else None


def bundled_worker_python(app_dir: str) -> str | None:
    """Return the immutable worker included in the application payload."""
    candidate = os.path.join(app_dir, "runtime", "worker", "python.exe")
    return candidate if os.path.isfile(candidate) else None


def venv_cuda_ok(py: str, log: Logger) -> bool:
    if shutil.which("nvidia-smi") is None:
        return True
    try:
        r = subprocess.run(
            [py, "-c", "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)"],
            capture_output=True,
            timeout=180,
            creationflags=_no_window(),
        )
        log.write(f"cuda check returncode={r.returncode}")
        return r.returncode == 0
    except Exception as exc:
        log.write(f"cuda check failed: {exc}")
        return False


def _no_window() -> int:
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def packaged_worker(app_dir: str, log: Logger) -> str | None:
    """Validate the worker; production startup must never provision packages."""
    py = bundled_worker_python(app_dir)
    if not py:
        log.write("packaged worker missing: runtime/worker/python.exe")
        return None
    return py


def kill_stale_servers(app_dir: str, runtime_dir: str, log: Logger) -> None:
    script = os.path.join(app_dir, "scripts", "kill_stale_bookvoice.ps1")
    if os.path.isfile(script):
        try:
            subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    script,
                    "-RuntimeDir",
                    runtime_dir,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=_no_window(),
            )
            log.write("ran kill_stale_bookvoice.ps1")
        except Exception as exc:
            log.write(f"kill_stale_bookvoice.ps1 failed: {exc}")

    if psutil is None:
        return
    server_markers = (
        os.path.join(runtime_dir, ".venv").lower(),
        os.path.join(app_dir, "runtime", "worker").lower(),
    )
    victims = []
    try:
        for proc in psutil.process_iter(["pid", "name", "exe", "cmdline"]):
            try:
                name = (proc.info["name"] or "").lower()
                if not name.startswith("python"):
                    continue
                cmd = " ".join(proc.info["cmdline"] or []).lower()
                exe = (proc.info["exe"] or "").lower()
                process_text = exe + " " + cmd
                if (
                    "uvicorn" in cmd
                    and "main:app" in cmd
                    and any(marker in process_text for marker in server_markers)
                ):
                    victims.append(proc)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception as exc:
        log.write(f"stale server scan error: {exc}")
        return

    for proc in victims:
        try:
            log.write(f"Killing stale BookVoice server pid={proc.pid}")
            children = proc.children(recursive=True)
            proc.terminate()
            for child in children:
                try:
                    child.terminate()
                except psutil.NoSuchProcess:
                    pass
            _gone, alive = psutil.wait_procs([proc, *children], timeout=5)
            for proc_alive in alive:
                try:
                    proc_alive.kill()
                except psutil.NoSuchProcess:
                    pass
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    if victims:
        time.sleep(1.5)


LOOPBACK_HOST = "127.0.0.1"


def resolve_pinned_port(requested: int | None = None) -> int:
    """A fixed port, when one is demanded, else 0 meaning 'scan for a free one'.

    A dashboard-managed tunnel routes its public hostname to a specific
    localhost port, so the app has to land on that exact port every time rather
    than taking whatever is free.
    """
    value = requested if requested else os.environ.get("BOOKVOICE_PORT", "")
    try:
        port = int(str(value).strip() or 0)
    except (TypeError, ValueError):
        return 0
    return port if 1 <= port <= 65535 else 0


def resolve_bind_host(requested: str | None = None) -> str:
    """The address uvicorn binds to. Loopback unless deliberately widened.

    ``--host``/``BOOKVOICE_HOST`` accepts an interface address, or ``lan`` /
    ``all`` as a friendly spelling of 0.0.0.0.
    """
    value = str(requested or os.environ.get("BOOKVOICE_HOST", "") or "").strip()
    if not value:
        return LOOPBACK_HOST
    if value.lower() in {"lan", "all", "any"}:
        return "0.0.0.0"
    return value


def is_loopback_host(host: str) -> bool:
    return str(host).strip().lower() in {LOOPBACK_HOST, "localhost", "::1"}


def lan_addresses() -> list[str]:
    """Best-effort list of this machine's addresses on the local network."""
    found = []
    try:
        # Connecting a UDP socket picks the interface that reaches the gateway
        # without sending anything.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.settimeout(0.2)
            probe.connect(("192.168.255.255", 1))
            found.append(probe.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = info[4][0]
            if address not in found and not address.startswith("127."):
                found.append(address)
    except OSError:
        pass
    return found


def pick_port(log: Logger, host: str = LOOPBACK_HOST, pinned: int = 0) -> int:
    if pinned:
        # Deliberately not falling back to another port: something is routed to
        # this one, and starting elsewhere would look like a broken tunnel
        # rather than a port conflict.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, pinned))
            except OSError:
                log.write(
                    f"WARNING: port {pinned} is already in use. Close whatever is "
                    "holding it — BookVoice will try to start on it anyway."
                )
        return pinned
    for port in range(PORT_START, PORT_END + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    log.write("all ports busy; falling back to 8000")
    return PORT_START


def backend_readiness(base_url: str) -> tuple[bool, str, bool]:
    """Return readiness as soon as the HTTP application is available.

    TTS readiness is intentionally independent: the library and cached audio
    remain usable while the model warms up or even if model loading fails.
    """
    try:
        with urllib.request.urlopen(f"{base_url}/api/health", timeout=1) as response:
            if response.status != 200:
                return False, "Waiting for backend connection…", False
        return True, "Library ready. AI voices may continue warming in the background.", False
    except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError):
        return False, "Waiting for backend connection…", False


def backend_is_ready(base_url: str) -> bool:
    """Compatibility helper for readiness checks and unit tests."""
    return backend_readiness(base_url)[0]


def import_prepared_book(base_url: str, archive_path: str) -> str:
    """Stream a .bookvoice archive into the local backend without loading it in RAM."""
    path = os.path.abspath(archive_path)
    if not path.lower().endswith(".bookvoice") or not os.path.isfile(path):
        raise ValueError("The prepared-book file does not exist or is not a .bookvoice archive.")
    parsed = urllib.parse.urlsplit(base_url)
    boundary = f"----BookVoice{hashlib.sha256(path.encode('utf-8')).hexdigest()[:24]}"
    filename = os.path.basename(path).replace('"', "")
    prefix = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        "Content-Type: application/zip\r\n\r\n"
    ).encode("utf-8")
    suffix = f"\r\n--{boundary}--\r\n".encode("ascii")
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=300)
    try:
        connection.putrequest("POST", "/api/books")
        connection.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
        connection.putheader("Content-Length", str(len(prefix) + os.path.getsize(path) + len(suffix)))
        connection.endheaders()
        connection.send(prefix)
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                connection.send(chunk)
        connection.send(suffix)
        response = connection.getresponse()
        payload = json.loads(response.read().decode("utf-8"))
        if response.status not in (200, 201):
            detail = payload.get("detail", {}) if isinstance(payload, dict) else {}
            raise ValueError(detail.get("message") or "The prepared book could not be imported.")
        book_id = str(payload.get("id", ""))
        if len(book_id) != 64:
            raise ValueError("The backend returned an invalid prepared-book identity.")
        return book_id
    finally:
        connection.close()


def build_env(app_dir: str, runtime_dir: str) -> dict:
    data_dir = os.path.join(runtime_dir, "data")
    os.makedirs(os.path.join(data_dir, "sessions"), exist_ok=True)
    voices_dir = resolve_voices_dir(app_dir, runtime_dir)
    os.makedirs(voices_dir, exist_ok=True)
    env = os.environ.copy()
    env["DATA_DIR"] = data_dir
    env["VOICE_DATA_DIR"] = voices_dir
    env["DEFAULT_VOICES_DIR"] = os.path.join(app_dir, "data", "default_voices")
    env["MODEL_DIR"] = os.path.join(app_dir, "data", "models")
    env["APP_DIR"] = app_dir
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONNOUSERSITE"] = "1"
    return env


def apply_tunnel_env(env: dict, origin: str) -> dict:
    """Trust the tunnel's own hostname, and keep cookies Secure over its HTTPS.

    The browser arrives from the tunnel hostname, which the loopback-only origin
    policy would otherwise reject. Cookies stay Secure over the tunnel's HTTPS,
    unless a LAN bind already had to relax that for plain HTTP — serving both at
    once, the weaker setting is the one that works everywhere.
    """
    if not origin:
        return env
    existing = str(env.get("BOOKVOICE_PUBLIC_ORIGIN", "") or "").split()
    if origin not in existing:
        existing.append(origin)
    env["BOOKVOICE_PUBLIC_ORIGIN"] = " ".join(part for part in existing if part)
    env.setdefault("BOOKVOICE_COOKIE_SECURE", "1")
    return env


def apply_network_env(env: dict, host: str) -> dict:
    """Let LAN browsers through when the app is deliberately bound beyond loopback.

    A phone on the same Wi-Fi arrives with a private-address Origin, which the
    loopback-only policy would reject, and over plain HTTP a Secure session
    cookie would be discarded. Both are relaxed only for a non-loopback bind,
    and only when the operator has not already made the call.
    """
    if is_loopback_host(host):
        return env
    env.setdefault("BOOKVOICE_ALLOW_PRIVATE_ORIGINS", "1")
    env.setdefault("BOOKVOICE_COOKIE_SECURE", "0")
    return env


def set_status(window, title: str, detail: str, progress: int | None = None) -> None:
    if window is None:
        return
    try:
        safe_title = json.dumps(title)
        safe_detail = json.dumps(detail)
        progress_js = ""
        if progress is not None:
            value = max(0, min(100, int(progress)))
            progress_js = (
                f"const value={value};"
                "const bar=document.getElementById('progress-bar');"
                "const meter=document.getElementById('progress');"
                "if(bar){bar.style.width=value+'%';}"
                "if(meter){meter.setAttribute('aria-valuenow',String(value));}"
            )
        window.evaluate_js(
            "(()=>{"
            f"document.getElementById('title').textContent={safe_title};"
            f"document.getElementById('detail').textContent={safe_detail};"
            f"{progress_js}"
            "})()"
        )
    except Exception:
        pass


def show_error(window, message: str, log_path: str | None = None) -> None:
    detail = ""
    if log_path and os.path.isfile(log_path):
        try:
            with open(log_path, encoding="utf-8", errors="replace") as handle:
                detail = "\n".join(handle.read().splitlines()[-25:])
        except OSError:
            pass
    safe_message = html_lib.escape(message)
    safe_detail = html_lib.escape(detail)
    technical = (
        f"<details><summary>Technical details</summary><pre>{safe_detail}</pre></details>"
        if safe_detail
        else ""
    )
    error_html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
    body{{font-family:'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;background:#18181b;color:#ededed;margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden}}
    .stage{{flex:1;overflow:auto;padding:3rem;max-width:44rem}}
    .eyebrow{{color:#82aed1;font-size:.72rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase}}
    h2{{font-size:1.6rem;margin:.6rem 0 1rem}} .message{{color:#d4d4d8;line-height:1.55}}
    .action{{color:#b6b6bd;line-height:1.55}} details{{margin-top:1.5rem;color:#a1a1aa}}
    summary{{cursor:pointer}} pre{{background:#101012;border:1px solid rgba(255,255,255,.12);padding:1rem;border-radius:4px;white-space:pre-wrap;font-size:12px;color:#b6b6bd}}
    </style></head><body><main class="stage"><div class="eyebrow">Startup problem</div><h2>BookVoice could not open</h2>
    <p class="message">{safe_message}</p><p class="action">Close BookVoice and try once more. If it repeats, reinstall the latest build. The launch log is in your BookVoice runtime folder.</p>{technical}
    </main></body></html>"""
    if window is not None and webview is not None:
        try:
            window.load_html(error_html)
            return
        except Exception:
            pass
    try:
        safe_msg = message[:500].replace('"', "'")
        subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Add-Type -AssemblyName PresentationFramework; "
                f'[System.Windows.MessageBox]::Show("{safe_msg}", "BookVoice")',
            ],
            creationflags=_no_window(),
        )
    except Exception:
        pass


def splash_html(icon_path: str) -> str:
    """Build the branded launch surface around the packaged BookVoice icon."""
    icon_data = ""
    try:
        with open(icon_path, "rb") as handle:
            icon_data = base64.b64encode(handle.read()).decode("ascii")
    except OSError:
        pass
    icon_markup = (
        f'<img class="app-icon" src="data:image/x-icon;base64,{icon_data}" alt="">'
        if icon_data
        else '<div class="icon-fallback" aria-hidden="true">BV</div>'
    )
    return """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="color-scheme" content="dark"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;font-family:'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;background:#18181b;color:#ededed}
*{box-sizing:border-box} body{height:100vh;margin:0;overflow:hidden;background:#18181b}
.splash{height:100%;display:grid;grid-template-columns:minmax(20rem,38%) 1fr}
.brand{position:relative;isolation:isolate;display:flex;flex-direction:column;justify-content:space-between;padding:3.5rem;background:#1f1f23;overflow:hidden}
.brand::before{content:'';position:absolute;inset:0;z-index:-1;background:radial-gradient(circle at 14% 18%,rgba(130,174,209,.28),transparent 42%),linear-gradient(150deg,rgba(52,80,106,.82),rgba(31,31,35,.96) 70%)}
.identity{display:flex;align-items:center;gap:1rem}.app-icon,.icon-fallback{width:4rem;height:4rem;flex:0 0 auto;filter:drop-shadow(0 10px 18px rgba(0,0,0,.22))}
.icon-fallback{display:grid;place-items:center;border:1px solid rgba(255,255,255,.3);background:#34506a;color:#fff;font-size:1.15rem;font-weight:700}
.product{font-size:1.75rem;font-weight:650;letter-spacing:-.025em}.purpose{max-width:19rem;color:#d4d4d8;font-family:Georgia,'Times New Roman',serif;font-size:1.05rem;line-height:1.55}
.signature{display:flex;align-items:flex-end;gap:.38rem;height:4.5rem;opacity:.62}.signature span{display:block;width:.24rem;background:#a8c6dd}.signature span:nth-child(1){height:28%}.signature span:nth-child(2){height:72%}.signature span:nth-child(3){height:46%}.signature span:nth-child(4){height:100%}.signature span:nth-child(5){height:58%}
.status-panel{display:flex;flex-direction:column;justify-content:flex-end;padding:4.25rem 4.75rem;background:#18181b;border-left:1px solid rgba(255,255,255,.08)}
.eyebrow{color:#82aed1;font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase}.status-copy{min-height:7rem;margin-top:.8rem}
h1{margin:0;font-size:1.55rem;font-weight:620;letter-spacing:-.018em}#detail{max-width:36rem;margin:.75rem 0 0;color:#b6b6bd;font-size:.92rem;line-height:1.55}
.progress-track{height:3px;margin-top:2.2rem;background:#27272a;overflow:hidden}.progress-bar{height:100%;width:0;background:#82aed1;transition:width 180ms ease-out}
.meta{display:flex;justify-content:space-between;margin-top:.75rem;color:#70707a;font-size:.68rem;letter-spacing:.08em;text-transform:uppercase}
@media (max-width:760px){.splash{grid-template-columns:1fr}.brand{display:none}.status-panel{padding:3rem}}
@media (prefers-reduced-motion:reduce){.progress-bar{transition:none}}
@media (forced-colors:active){.brand::before{background:Canvas}.brand,.status-panel{background:Canvas;color:CanvasText;border-color:CanvasText}.progress-track{border:1px solid CanvasText;background:Canvas}.progress-bar{background:Highlight}}
</style></head><body><main class="splash">
<section class="brand" aria-label="BookVoice"><div class="identity">__ICON__<div class="product">BookVoice</div></div><div><div class="signature" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div><p class="purpose">Read, listen, and create with your own voice library.</p></div></section>
<section class="status-panel" aria-live="polite" aria-atomic="true"><div class="eyebrow">Preparing your workspace</div><div class="status-copy"><h1 id="title">Starting BookVoice</h1><p id="detail">Waiting for startup checks…</p></div>
<div id="progress" class="progress-track" role="progressbar" aria-label="Startup progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="progress-bar" class="progress-bar"></div></div><div class="meta"><span>Local desktop app</span><span>BookVoice</span></div></section>
</main></body></html>""".replace("__ICON__", icon_markup)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BookVoice launcher")
    parser.add_argument(
        "--browser",
        action="store_true",
        help="Open the default browser instead of a native window",
    )
    parser.add_argument(
        "--no-window",
        action="store_true",
        help="Start the backend only (no UI shell)",
    )
    parser.add_argument(
        "--tunnel",
        nargs="?",
        const="cloudflare",
        default=None,
        help=(
            "Publish over Cloudflare Tunnel. With --tunnel-name and "
            "--tunnel-hostname the address is permanent; without them Cloudflare "
            "issues a new random URL on every start."
        ),
    )
    parser.add_argument(
        "--tunnel-name",
        default=None,
        help="Named Cloudflare tunnel to run (created once with `cloudflared tunnel create`).",
    )
    parser.add_argument(
        "--tunnel-hostname",
        default=None,
        help="Permanent hostname routed to the tunnel, e.g. bookvoice.example.com.",
    )
    parser.add_argument(
        "--tunnel-token",
        default=None,
        help=(
            "Token for a tunnel created in the Cloudflare dashboard. Its ingress "
            "lives in Cloudflare, so pair this with --port matching the public "
            "hostname you routed."
        ),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help=(
            "Pin the local port instead of scanning 8000-8020. Required when a "
            "dashboard tunnel points at a fixed localhost port."
        ),
    )
    parser.add_argument(
        "--host",
        default=None,
        help=(
            "Address to bind (default 127.0.0.1, this machine only). Use 'lan' "
            "to accept connections from other devices on your network. Anyone "
            "who can reach the port gets full access unless "
            "BOOKVOICE_ACCESS_PASSWORD is set."
        ),
    )
    parser.add_argument(
        "book_path",
        nargs="?",
        help="A .bookvoice archive to import and open.",
    )
    return parser.parse_args(argv)


def create_main_window(webview_module, app_dir: str | None = None):
    # Let Windows own the non-client frame. Native chrome provides reliable
    # resize borders, Snap Layouts, taskbar-aware maximization, and standard
    # title-bar double-click behavior without reimplementing Win32 hit testing.
    return webview_module.create_window(
        "BookVoice",
        html=splash_html(os.path.join(app_dir or resolve_app_dir(), "bookvoice.ico")),
        width=1440,
        height=900,
        min_size=(1024, 700),
        resizable=True,
        frameless=False,
        easy_drag=False,
        background_color="#18181b",
    )


def configure_system_tray(window, app_dir: str, log: Logger):
    """Attach minimize-to-tray behavior to the native desktop window."""
    try:
        controller = system_tray.SystemTray(
            window,
            os.path.join(app_dir, "bookvoice.ico"),
            log,
        )
        controller.start()
    except system_tray.TrayUnavailable as exc:
        log.write(f"notification-area icon unavailable: {exc}")
        return None
    window.events.minimized += controller.minimize_to_tray
    log.write("notification-area icon ready; minimizing hides the taskbar window")
    return controller


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    app_dir = resolve_app_dir()
    runtime_dir = resolve_runtime_dir(app_dir)
    legacy_dir = legacy_runtime_dir()
    os.makedirs(runtime_dir, exist_ok=True)
    log = Logger(_log_path(runtime_dir, app_dir))
    log.write("==== launch start ====")
    log.write(f"frozen={getattr(sys, 'frozen', False)}")
    log.write(f"executable={sys.executable}")
    log.write(f"app_dir={app_dir}")
    log.write(f"runtime_dir={runtime_dir}")
    log.write(f"install_id={install_id(app_dir, read_app_version(app_dir))}")

    migrate_legacy_runtime(legacy_dir, runtime_dir, log)

    err = validate_package(app_dir)
    if err:
        log.write(f"package invalid: {err}")
        show_error(None, err, log.path)
        return 1

    voices_dir = resolve_voices_dir(app_dir, runtime_dir)
    try:
        migrated_voices = migrate_voice_library(app_dir, runtime_dir, voices_dir, log)
        if migrated_voices:
            log.write(f"recovered {migrated_voices} voice library file(s)")
    except OSError as exc:
        # One locked/corrupt historical file must never prevent BookVoice from
        # opening; later launches can retry the idempotent migration.
        log.write(f"voice library recovery will retry later: {exc}")
    clear_pycache(app_dir)
    seed_voices(app_dir, voices_dir)
    os.chdir(app_dir)

    use_webview = webview is not None and not args.browser and not args.no_window
    window = None
    process = None
    log_file = None
    tray_controller = None

    if use_webview:
        configure_webview_gpu()
        configure_webview_downloads(webview)
        log.write(
            "webview gpu args="
            + os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "(default)")
        )
        window = create_main_window(webview, app_dir)
        tray_controller = configure_system_tray(window, app_dir, log)

    state = {"error": None}
    tunnel_handle: dict = {}

    def worker():
        nonlocal process, log_file
        try:
            def status(title, detail, progress):
                set_status(window, title, detail, progress)
                log.write(f"status: {title} | {detail}")

            status("Checking runtime", "Verifying the bundled reading engine…", 12)
            py = packaged_worker(app_dir, log)
            if not py:
                state["error"] = "The packaged reading engine is incomplete. Reinstall BookVoice."
                show_error(window, state["error"], log.path)
                return

            kill_stale_servers(app_dir, runtime_dir, log)
            bind_host = resolve_bind_host(args.host)
            port = pick_port(log, bind_host, resolve_pinned_port(args.port))
            env = apply_network_env(build_env(app_dir, runtime_dir), bind_host)
            status("Preparing local service", "Selecting a private local address…", 30)
            log.write(f"env DATA_DIR={env['DATA_DIR']}")
            log.write(f"env VOICE_DATA_DIR={env['VOICE_DATA_DIR']}")
            log.write(f"env MODEL_DIR={env['MODEL_DIR']}")
            log.write(f"venv={py}")
            log.write(f"port={port}")
            log.write(f"bind={bind_host}")

            tunnel_settings = tunnel.resolve_settings(runtime_dir, {
                "mode": args.tunnel,
                "name": args.tunnel_name,
                "hostname": args.tunnel_hostname,
                "token": args.tunnel_token,
            })
            if tunnel.is_enabled(tunnel_settings):
                status("Opening tunnel", "Publishing BookVoice over Cloudflare…", 42)
                try:
                    active_tunnel = tunnel.start_tunnel(
                        tunnel_settings, port, runtime_dir, log=log
                    )
                    tunnel_handle["tunnel"] = active_tunnel
                    env = apply_tunnel_env(env, active_tunnel.url)
                    log.write(f"tunnel ready at {active_tunnel.url}")
                    if not tunnel.is_named(tunnel_settings):
                        log.write(
                            "NOTE: this is a quick tunnel — Cloudflare issues a new "
                            "address every start. Use --tunnel-name and "
                            "--tunnel-hostname for a permanent one."
                        )
                    if tunnel.is_remote_managed(tunnel_settings):
                        log.write(
                            f"dashboard tunnel: point its public hostname at "
                            f"http://localhost:{port}"
                        )
                        if not resolve_pinned_port(args.port):
                            log.write(
                                "WARNING: no --port given. A dashboard tunnel routes to "
                                "one fixed port, but this launch scanned for a free one "
                                "and may pick a different port next time."
                            )
                    hostname_warning = tunnel.missing_hostname_warning(tunnel_settings)
                    if hostname_warning:
                        log.write(f"WARNING: {hostname_warning}")
                        status("Tunnel needs a hostname", hostname_warning, 46)
                    if not env.get("BOOKVOICE_ACCESS_PASSWORD"):
                        log.write(
                            "WARNING: the tunnel is reachable from the public internet "
                            "with no BOOKVOICE_ACCESS_PASSWORD set."
                        )
                except tunnel.TunnelError as exc:
                    # The app is still perfectly usable locally, so this is
                    # reported rather than treated as a failure to launch.
                    log.write(f"tunnel unavailable: {exc}")
                    status("Tunnel unavailable", str(exc), 46)

            if not is_loopback_host(bind_host):
                for address in lan_addresses():
                    log.write(f"reachable on this network at http://{address}:{port}")
                if not env.get("BOOKVOICE_ACCESS_PASSWORD"):
                    log.write(
                        "WARNING: bound beyond loopback with no BOOKVOICE_ACCESS_PASSWORD. "
                        "Anyone who can reach this port has full access to your voice "
                        "profiles and Studio projects."
                    )

            status("Starting reading service", f"Launching locally on {bind_host}:{port}…", 58)
            server_log = os.path.join(runtime_dir, "bookvoice_server.log")
            try:
                if os.path.isfile(server_log):
                    prev = os.path.join(runtime_dir, "bookvoice_server.prev.log")
                    if os.path.isfile(prev):
                        os.remove(prev)
                    os.replace(server_log, prev)
            except OSError:
                pass
            log_file = open(server_log, "w", encoding="utf-8", errors="replace")
            cmd = [py, "-m", "uvicorn", "main:app", "--host", bind_host, "--port", str(port)]
            process = subprocess.Popen(
                cmd,
                cwd=app_dir,
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                creationflags=_no_window(),
            )
            log.write(f"started pid={process.pid}")
            status("Loading reading engine", "Waiting for voices and media tools…", 72)

            def stop_server():
                """Terminate the backend process tree; safe to call repeatedly."""
                children = []
                if psutil is not None and process.poll() is None:
                    try:
                        children = psutil.Process(process.pid).children(recursive=True)
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        children = []
                if process.poll() is None:
                    process.terminate()
                for child in children:
                    try:
                        child.terminate()
                    except psutil.NoSuchProcess:
                        pass
                try:
                    process.wait(timeout=3)
                except Exception:
                    process.kill()

            def watch_server(watch_url, reload_url):
                """Restart the backend if it dies or stops accepting connections.

                uvicorn's Windows proactor accept loop can die silently
                (WinError 64) when a client aborts a connection mid-accept:
                the process stays alive but never accepts another socket.
                Poll /api/health — cheap and model-independent, so normal
                model warmup never trips it — and restart on sustained
                failure or process exit.
                """
                nonlocal process, log_file
                misses = 0
                restarts = 0
                while True:
                    time.sleep(5)
                    reason = None
                    if process.poll() is not None:
                        reason = f"backend exited (code {process.returncode})"
                    elif backend_readiness(watch_url)[0]:
                        misses = 0
                    else:
                        misses += 1
                        if misses >= 6:
                            reason = "backend stopped answering health checks"
                    if reason is None:
                        continue
                    restarts += 1
                    if restarts > 5:
                        state["error"] = (
                            "Reading service kept failing; gave up after 5 restarts."
                        )
                        log.write(state["error"])
                        stop_server()
                        show_error(window, state["error"], server_log)
                        return
                    log.write(f"watchdog: {reason}; restart {restarts}/5")
                    status(
                        "Restarting reading service",
                        "The reading engine stopped responding; restarting…",
                        72,
                    )
                    stop_server()
                    try:
                        log_file.close()
                    except OSError:
                        pass
                    log_file = open(server_log, "a", encoding="utf-8", errors="replace")
                    process = subprocess.Popen(
                        cmd,
                        cwd=app_dir,
                        env=env,
                        stdout=log_file,
                        stderr=subprocess.STDOUT,
                        creationflags=_no_window(),
                    )
                    log.write(f"watchdog: restarted pid={process.pid}")
                    for _ in range(300):
                        if process.poll() is not None:
                            break
                        if backend_readiness(watch_url)[0]:
                            misses = 0
                            if window is not None:
                                window.load_url(reload_url)
                            break
                        time.sleep(1)

            for i in range(300):
                if process.poll() is not None:
                    state["error"] = "Backend exited early"
                    show_error(window, state["error"], server_log)
                    return
                url = f"http://127.0.0.1:{port}"
                ready, detail, failed = backend_readiness(url)
                if ready:
                    log.write(f"ready {url}")
                    params = {}
                    if window is not None:
                        # Tell the frontend it runs inside the frameless
                        # native shell so it renders the window controls.
                        params["shell"] = "native"
                    if args.book_path:
                        status("Opening prepared book", "Validating and importing the archive…", 88)
                        book_id = import_prepared_book(url, args.book_path)
                        params["book"] = book_id
                        log.write(f"imported prepared book {book_id}")
                    open_url = f"{url}/?{urllib.parse.urlencode(params)}" if params else url
                    if args.no_window:
                        log.write("backend ready (--no-window)")
                    else:
                        if window is not None:
                            status("Ready", "Opening your BookVoice workspace…", 100)
                            window.load_url(open_url)
                        else:
                            os.startfile(open_url)  # type: ignore[attr-defined]
                    watch_server(url, open_url)
                    return
                if failed:
                    state["error"] = f"TTS model failed to load: {detail}"
                    log.write(state["error"])
                    show_error(window, state["error"], server_log)
                    return
                if i % 10 == 0:
                    status("Loading reading engine", f"{detail} ({i}s)", 72)
                time.sleep(1)

            state["error"] = "Backend did not become ready in time"
            show_error(window, state["error"], server_log)
        except Exception as exc:
            log.write(traceback.format_exc())
            state["error"] = str(exc)
            show_error(window, state["error"], log.path)

    threading.Thread(target=worker, daemon=True).start()

    if use_webview and window is not None:
        webview.start()
    else:
        while process is None and state["error"] is None:
            time.sleep(0.2)
        if args.no_window and process is not None:
            try:
                process.wait()
            except Exception:
                pass
        elif process is not None and not args.no_window:
            try:
                process.wait()
            except Exception:
                pass

    try:
        if process is not None and process.poll() is None and not args.no_window:
            children = []
            if psutil is not None:
                try:
                    children = psutil.Process(process.pid).children(recursive=True)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    children = []
            process.terminate()
            for child in children:
                try:
                    child.terminate()
                except Exception:
                    pass
            try:
                process.wait(timeout=3)
            except Exception:
                process.kill()
    finally:
        if tray_controller is not None:
            tray_controller.stop()
        active_tunnel = tunnel_handle.get("tunnel")
        if active_tunnel is not None:
            try:
                active_tunnel.stop()
                log.write("tunnel closed")
            except Exception as exc:  # noqa: BLE001 - shutdown must not fail here
                log.write(f"tunnel shutdown skipped: {exc}")
        if log_file is not None:
            try:
                log_file.close()
            except Exception:
                pass
    log.write("==== launch end ====")
    return 0 if state["error"] is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
