"""
BookVoice desktop launcher.

Starts the FastAPI backend with absolute env vars and a scoped writable runtime,
then opens a native window or the default browser.

MSI installs (Program Files or LocalAppData) and dev runs all use this logic.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime

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


def seed_voices(app_dir: str, data_dir: str) -> None:
    src = os.path.join(app_dir, "data", "default_voices")
    dst = os.path.join(data_dir, "voices")
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


def venv_python(runtime_dir: str) -> str:
    return os.path.join(runtime_dir, ".venv", "Scripts", "python.exe")


def venv_has_chatterbox(runtime_dir: str) -> bool:
    return os.path.isdir(
        os.path.join(runtime_dir, ".venv", "Lib", "site-packages", "chatterbox")
    )


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


def ensure_venv(app_dir: str, runtime_dir: str, log: Logger, status_cb) -> str | None:
    py = venv_python(runtime_dir)
    os.makedirs(runtime_dir, exist_ok=True)
    embed = bundled_python(app_dir)

    if not (os.path.isfile(py) and venv_has_chatterbox(runtime_dir)):
        status_cb("First-time setup", "Installing Python packages (several minutes)...")
        log.write("Running setup_venv.bat")
        for name in ("requirements.txt", "setup_venv.bat", "fix_cuda_torch.bat"):
            src = os.path.join(app_dir, name)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(runtime_dir, name))
        setup = os.path.join(runtime_dir, "setup_venv.bat")
        if not os.path.isfile(setup):
            setup = os.path.join(app_dir, "setup_venv.bat")
        if not os.path.isfile(setup):
            log.write("setup_venv.bat missing")
            return None
        setup_log = os.path.join(runtime_dir, "bookvoice_setup.log")
        env = os.environ.copy()
        if embed:
            env["BOOKVOICE_EMBED_PYTHON"] = embed
        try:
            with open(setup_log, "w", encoding="utf-8", errors="replace") as lf:
                subprocess.run(
                    setup,
                    cwd=runtime_dir,
                    env=env,
                    stdout=lf,
                    stderr=subprocess.STDOUT,
                    shell=True,
                    check=True,
                    creationflags=_no_window(),
                )
        except Exception as exc:
            log.write(f"setup_venv failed: {exc}")
            return None
        if not os.path.isfile(py):
            log.write("venv python still missing after setup")
            return None

    if not venv_cuda_ok(py, log):
        status_cb("Enabling GPU", "Installing CUDA PyTorch (one-time large download)...")
        fix = os.path.join(app_dir, "fix_cuda_torch.bat")
        if os.path.isfile(fix):
            fix_log = os.path.join(runtime_dir, "bookvoice_cuda_fix.log")
            try:
                with open(fix_log, "w", encoding="utf-8", errors="replace") as lf:
                    subprocess.run(
                        ["cmd", "/c", fix, py],
                        cwd=runtime_dir,
                        stdout=lf,
                        stderr=subprocess.STDOUT,
                        creationflags=_no_window(),
                    )
            except Exception as exc:
                log.write(f"cuda fix failed: {exc}")
        log.write(f"cuda after fix: {venv_cuda_ok(py, log)}")

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
    venv_marker = os.path.join(runtime_dir, ".venv").lower()
    victims = []
    try:
        for proc in psutil.process_iter(["pid", "name", "exe", "cmdline"]):
            try:
                name = (proc.info["name"] or "").lower()
                if not name.startswith("python"):
                    continue
                cmd = " ".join(proc.info["cmdline"] or []).lower()
                exe = (proc.info["exe"] or "").lower()
                if "uvicorn" in cmd and "main:app" in cmd and venv_marker in (exe + " " + cmd):
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


def pick_port(log: Logger) -> int:
    for port in range(PORT_START, PORT_END + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    log.write("all ports busy; falling back to 8000")
    return PORT_START


def backend_is_ready(base_url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{base_url}/api/health", timeout=1) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def build_env(app_dir: str, runtime_dir: str) -> dict:
    data_dir = os.path.join(runtime_dir, "data")
    os.makedirs(os.path.join(data_dir, "voices"), exist_ok=True)
    os.makedirs(os.path.join(data_dir, "sessions"), exist_ok=True)
    env = os.environ.copy()
    env["DATA_DIR"] = data_dir
    env["DEFAULT_VOICES_DIR"] = os.path.join(app_dir, "data", "default_voices")
    env["MODEL_DIR"] = os.path.join(app_dir, "data", "models")
    env["APP_DIR"] = app_dir
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONNOUSERSITE"] = "1"
    embed = bundled_python(app_dir)
    if embed:
        env["BOOKVOICE_EMBED_PYTHON"] = embed
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
    body{{font-family:Segoe UI,sans-serif;background:#14110f;color:#e5e5e5;padding:2rem}}
    h2{{color:#f87171}} pre{{background:#1f1b18;padding:1rem;border-radius:8px;white-space:pre-wrap;font-size:12px;color:#fca5a5}}
    </style></head><body><h2>BookVoice failed to start</h2><pre>{text}</pre>
    <p>See bookvoice_launch.log in your runtime folder.</p>
    </body></html>"""
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


SPLASH = """<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:Segoe UI,sans-serif;background:#14110f;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;max-width:28rem;padding:1rem}
.loader{border:3px solid rgba(255,255,255,.1);border-top:3px solid #c9956b;border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite;margin:0 auto 1.25rem}
@keyframes spin{to{transform:rotate(360deg)}}
h2{font-weight:500;font-size:1.15rem;margin:0} p{color:#9ca3af;margin-top:.5rem;line-height:1.4}
</style></head><body><div class="box"><div class="loader"></div>
<h2 id="title">Starting BookVoice</h2><p id="detail">Preparing…</p></div></body></html>"""


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
    return parser.parse_args(argv)


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

    clear_pycache(app_dir)
    seed_voices(app_dir, os.path.join(runtime_dir, "data"))
    os.chdir(app_dir)

    use_webview = webview is not None and not args.browser and not args.no_window
    window = None
    process = None
    log_file = None

    if use_webview:
        window = webview.create_window("BookVoice", html=SPLASH, width=1280, height=800)

    state = {"error": None}

    def worker():
        nonlocal process, log_file
        try:
            def status(title, detail):
                set_status(window, title, detail)
                log.write(f"status: {title} | {detail}")

            status("Checking environment", "Looking for Python packages…")
            py = ensure_venv(app_dir, runtime_dir, log, status)
            if not py:
                state["error"] = "Failed to create Python environment. See bookvoice_setup.log"
                show_error(window, state["error"], os.path.join(runtime_dir, "bookvoice_setup.log"))
                return

            kill_stale_servers(app_dir, runtime_dir, log)
            port = pick_port(log)
            env = build_env(app_dir, runtime_dir)
            log.write(f"env DATA_DIR={env['DATA_DIR']}")
            log.write(f"env MODEL_DIR={env['MODEL_DIR']}")
            log.write(f"venv={py}")
            log.write(f"port={port}")

            status("Starting AI Engine", f"Launching backend on 127.0.0.1:{port}…")
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
            cmd = [py, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port)]
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
                if backend_is_ready(url):
                    log.write(f"ready {url}")
                    if args.no_window:
                        log.write("backend ready (--no-window)")
                        return
                    if window is not None:
                        window.load_url(url)
                    else:
                        os.startfile(url)  # type: ignore[attr-defined]
                    return
                if i % 10 == 0:
                    status("Starting AI Engine", f"Waiting for backend… ({i}s)")
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
        if log_file is not None:
            try:
                log_file.close()
            except Exception:
                pass
    log.write("==== launch end ====")
    return 0 if state["error"] is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
