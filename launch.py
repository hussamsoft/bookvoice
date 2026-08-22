"""
BookVoice desktop launcher.

Starts the FastAPI backend with absolute env vars and a scoped writable runtime,
then opens a native window or the default browser.

MSI installs (Program Files or LocalAppData) and dev runs all use this logic.
"""
from __future__ import annotations

import argparse
import hashlib
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


def read_app_version(app_dir: str) -> str:
    version_path = os.path.join(app_dir, "VERSION")
    try:
        with open(version_path, encoding="utf-8") as handle:
            return handle.read().strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def install_id(app_dir: str, version: str) -> str:
    payload = f"{os.path.normcase(os.path.abspath(app_dir))}|{version.strip()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


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
        install_id(app_dir, version),
    )
    return scoped


def migrate_legacy_runtime(legacy_dir: str, scoped_dir: str, log: Logger) -> None:
    if os.path.abspath(legacy_dir) == os.path.abspath(scoped_dir):
        return
    if os.path.isdir(scoped_dir) and any(os.scandir(scoped_dir)):
        return
    if not os.path.isdir(legacy_dir):
        return

    os.makedirs(scoped_dir, exist_ok=True)
    for name in (".venv", "data"):
        src = os.path.join(legacy_dir, name)
        dst = os.path.join(scoped_dir, name)
        if not os.path.exists(src) or os.path.exists(dst):
            continue
        try:
            shutil.move(src, dst)
            log.write(f"migrated legacy {name} -> {dst}")
        except OSError as exc:
            log.write(f"legacy migration skipped for {name}: {exc}")

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


def set_status(window, title: str, detail: str) -> None:
    if window is None:
        return
    try:
        window.evaluate_js(
            f"document.getElementById('title').textContent = {title!r};"
            f"document.getElementById('detail').textContent = {detail!r};"
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
    text = (message + "\n\n" + detail).replace("\\", "\\\\").replace("`", "\\`").replace("\n", "\\n")
    html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
    body{{font-family:'Segoe UI',system-ui,sans-serif;background:#ffffff;color:#18181b;margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden}}
    .stage{{flex:1;overflow:auto;padding:2rem}}
    h2{{color:#b4342f}} pre{{background:#f9f9f9;border:1px solid rgba(0,0,0,.12);padding:1rem;border-radius:8px;white-space:pre-wrap;font-size:12px;color:#52525b}}
    p{{color:#70707a}}
    </style></head><body><div class="stage"><h2>BookVoice failed to start</h2><pre>{text}</pre>
    <p>See bookvoice_launch.log in your runtime folder.</p>
    </div></body></html>"""
    if window is not None and webview is not None:
        try:
            window.load_html(html)
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


SPLASH = f"""<!doctype html><html><head><meta charset="utf-8"><style>
body{{font-family:'Segoe UI',system-ui,sans-serif;background:#ffffff;color:#18181b;display:flex;flex-direction:column;height:100vh;margin:0;overflow:hidden}}
.stage{{flex:1;display:flex;align-items:center;justify-content:center}}
.box{{text-align:center;max-width:28rem;padding:1rem}}
.loader{{border:3px solid rgba(62,96,124,.18);border-top:3px solid #3e607c;border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite;margin:0 auto 1.25rem}}
@keyframes spin{{to{{transform:rotate(360deg)}}}}
h2{{font-weight:600;font-size:1.15rem;margin:0}} p{{color:#70707a;margin-top:.5rem;line-height:1.4}}
</style></head><body><div class="stage"><div class="box"><div class="loader"></div>
<h2 id="title">Starting BookVoice</h2><p id="detail">Preparing…</p></div></div></body></html>"""


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


def create_main_window(webview_module):
    # Let Windows own the non-client frame. Native chrome provides reliable
    # resize borders, Snap Layouts, taskbar-aware maximization, and standard
    # title-bar double-click behavior without reimplementing Win32 hit testing.
    return webview_module.create_window(
        "BookVoice",
        html=SPLASH,
        width=1440,
        height=900,
        min_size=(1024, 700),
        resizable=True,
        frameless=False,
        easy_drag=False,
        background_color="#ffffff",
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
        window = create_main_window(webview)
        tray_controller = configure_system_tray(window, app_dir, log)

    state = {"error": None}
    tunnel_handle: dict = {}

    def worker():
        nonlocal process, log_file
        try:
            def status(title, detail):
                set_status(window, title, detail)
                log.write(f"status: {title} | {detail}")

            status("Checking runtime", "Verifying the bundled reading engine…")
            py = packaged_worker(app_dir, log)
            if not py:
                state["error"] = "The packaged reading engine is incomplete. Reinstall BookVoice."
                show_error(window, state["error"], log.path)
                return

            kill_stale_servers(app_dir, runtime_dir, log)
            bind_host = resolve_bind_host(args.host)
            port = pick_port(log, bind_host, resolve_pinned_port(args.port))
            env = apply_network_env(build_env(app_dir, runtime_dir), bind_host)
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
                status("Opening tunnel", "Publishing BookVoice over Cloudflare…")
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
                        status("Tunnel needs a hostname", hostname_warning)
                    if not env.get("BOOKVOICE_ACCESS_PASSWORD"):
                        log.write(
                            "WARNING: the tunnel is reachable from the public internet "
                            "with no BOOKVOICE_ACCESS_PASSWORD set."
                        )
                except tunnel.TunnelError as exc:
                    # The app is still perfectly usable locally, so this is
                    # reported rather than treated as a failure to launch.
                    log.write(f"tunnel unavailable: {exc}")
                    status("Tunnel unavailable", str(exc))

            if not is_loopback_host(bind_host):
                for address in lan_addresses():
                    log.write(f"reachable on this network at http://{address}:{port}")
                if not env.get("BOOKVOICE_ACCESS_PASSWORD"):
                    log.write(
                        "WARNING: bound beyond loopback with no BOOKVOICE_ACCESS_PASSWORD. "
                        "Anyone who can reach this port has full access to your voice "
                        "profiles and Studio projects."
                    )

            status("Starting AI Engine", f"Launching backend on {bind_host}:{port}…")
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
                        status("Opening prepared book", "Validating and importing the archive…")
                        book_id = import_prepared_book(url, args.book_path)
                        params["book"] = book_id
                        log.write(f"imported prepared book {book_id}")
                    open_url = f"{url}/?{urllib.parse.urlencode(params)}" if params else url
                    if args.no_window:
                        log.write("backend ready (--no-window)")
                        return
                    if window is not None:
                        window.load_url(open_url)
                    else:
                        os.startfile(open_url)  # type: ignore[attr-defined]
                    return
                if failed:
                    state["error"] = f"TTS model failed to load: {detail}"
                    log.write(state["error"])
                    show_error(window, state["error"], server_log)
                    return
                if i % 10 == 0:
                    status("Starting AI Engine", f"{detail} ({i}s)")
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
