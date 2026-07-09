import subprocess
import webview
import time
import sys
import os
import socket
import psutil
import threading
import shutil
from pathlib import Path


APP_NAME = "BookVoice"


def get_listening_pid(port):
    try:
        for conn in psutil.net_connections(kind="inet"):
            if conn.laddr.port == port and conn.status == "LISTEN":
                return conn.pid
    except psutil.AccessDenied:
        pass
    return None


def is_bookvoice_process(pid):
    try:
        proc = psutil.Process(pid)
        cmdline = " ".join(proc.cmdline()).lower()
        return "uvicorn" in cmdline and "main:app" in cmdline
    except (psutil.NoSuchProcess, psutil.AccessDenied, TypeError):
        pass
    return False


def find_available_port(start_port=8000, max_port=8020):
    port = start_port
    while port <= max_port:
        pid = get_listening_pid(port)
        if pid is None:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                try:
                    s.bind(("127.0.0.1", port))
                    return port
                except OSError:
                    pass
        else:
            if is_bookvoice_process(pid):
                try:
                    psutil.Process(pid).terminate()
                    time.sleep(1)
                    if psutil.pid_exists(pid):
                        psutil.Process(pid).kill()
                    return port
                except Exception:
                    pass
        port += 1
    return None


def _looks_like_app_dir(path: str) -> bool:
    return os.path.isfile(os.path.join(path, "main.py")) and os.path.isdir(
        os.path.join(path, "static")
    )


def resolve_app_dir():
    """
    Locate the folder that contains main.py + static/ + data/.

    Portable layout: Launcher.exe lives *next to* main.py (dist/ or install dir).
    MSI layout: same — everything under INSTALLDIR.
    """
    # 1) Frozen EXE: prefer directory of Launcher.exe (portable / MSI install root)
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        if _looks_like_app_dir(exe_dir):
            return exe_dir
        # Optional onedir layout: _MEIPASS/dist
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            candidate = os.path.join(meipass, "dist")
            if _looks_like_app_dir(candidate):
                return os.path.abspath(candidate)
        return exe_dir

    # 2) Dev: search near launch.py
    application_path = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(application_path, "dist"),
        application_path,
        os.path.join(os.path.dirname(application_path), "dist"),
        os.path.join(application_path, "backend"),
    ]
    for c in candidates:
        c = os.path.abspath(c)
        if _looks_like_app_dir(c):
            return c
    for c in candidates:
        c = os.path.abspath(c)
        if os.path.isfile(os.path.join(c, "main.py")):
            return c
    return os.path.abspath(application_path)


def resolve_data_dir(app_dir: str):
    """
    Writable runtime data (.venv, sessions, voices).

    Default (same as MSI): %LOCALAPPDATA%\\BookVoice so Program Files installs
    stay writable without admin.

    Portable override: set BOOKVOICE_PORTABLE=1 to keep .venv/data next to the app.
    """
    if os.environ.get("BOOKVOICE_PORTABLE", "").strip() in ("1", "true", "yes"):
        return os.path.join(app_dir, ".bookvoice_data")
    base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
    return os.path.join(base, APP_NAME)


def _venv_python(data_dir: str) -> str:
    return os.path.join(data_dir, ".venv", "Scripts", "python.exe")


def _venv_has_chatterbox(data_dir: str) -> bool:
    site = os.path.join(data_dir, ".venv", "Lib", "site-packages", "chatterbox")
    return os.path.isdir(site)


def _venv_cuda_ok(venv_python: str) -> bool:
    """Return True if this venv's torch can see a CUDA GPU."""
    if not os.path.isfile(venv_python):
        return False
    try:
        # nvidia-smi missing → no point
        if shutil.which("nvidia-smi") is None:
            return True  # no GPU expected; don't force reinstall
        r = subprocess.run(
            [
                venv_python,
                "-c",
                "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)",
            ],
            capture_output=True,
            timeout=120,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return r.returncode == 0
    except Exception:
        return False


def seed_default_voices(app_dir, data_dir):
    src = os.path.join(app_dir, "data", "default_voices")
    if not os.path.isdir(src):
        return
    dst = os.path.join(data_dir, "data", "voices")
    os.makedirs(dst, exist_ok=True)
    for fn in os.listdir(src):
        if fn.endswith(".wav"):
            sf = os.path.join(src, fn)
            df = os.path.join(dst, fn)
            if not os.path.exists(df):
                shutil.copy2(sf, df)


def set_status(window, title, detail):
    try:
        window.evaluate_js(
            f"document.getElementById('title').textContent = {title!r};"
            f"document.getElementById('detail').textContent = {detail!r};"
        )
    except Exception:
        pass


def _run_bat(script_path: str, cwd: str, log_path: str) -> None:
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    with open(log_path, "w", encoding="utf-8", errors="replace") as log:
        subprocess.run(
            script_path,
            cwd=cwd,
            stdout=log,
            stderr=subprocess.STDOUT,
            shell=True,
            check=True,
            creationflags=creationflags,
        )


def ensure_venv(app_dir, data_dir, window):
    """
    Ensure a working venv with chatterbox + (when NVIDIA present) CUDA torch.
    Long-running; caller must not enforce a short overall timeout while this runs.
    """
    venv_python = _venv_python(data_dir)
    log_path = os.path.join(data_dir, "bookvoice_setup.log")

    need_full_setup = not (os.path.exists(venv_python) and _venv_has_chatterbox(data_dir))
    if need_full_setup:
        if os.path.exists(venv_python):
            set_status(window, "Fixing environment", "Rebuilding Python environment…")
            shutil.rmtree(os.path.join(data_dir, ".venv"), ignore_errors=True)
        else:
            set_status(
                window,
                "First-time setup",
                "Installing dependencies (may take several minutes, including CUDA)…",
            )

        req_src = os.path.join(app_dir, "requirements.txt")
        if not os.path.isfile(req_src):
            set_status(window, "Setup failed", "requirements.txt not found in app directory.")
            return None

        os.makedirs(data_dir, exist_ok=True)
        shutil.copy2(req_src, os.path.join(data_dir, "requirements.txt"))
        # Copy bootstrap scripts into data dir so relative paths work
        for name in ("setup_venv.bat", "fix_cuda_torch.bat"):
            src = os.path.join(app_dir, name)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(data_dir, name))

        setup_script = os.path.join(data_dir, "setup_venv.bat")
        if not os.path.isfile(setup_script):
            setup_script = os.path.join(app_dir, "setup_venv.bat")
        if not os.path.isfile(setup_script):
            set_status(window, "Setup failed", "setup_venv.bat not found.")
            return None

        try:
            _run_bat(setup_script, data_dir, log_path)
        except Exception as e:
            set_status(window, "Setup failed", f"Could not create the Python environment: {e}")
            return None

        if not os.path.exists(venv_python):
            set_status(
                window,
                "Setup failed",
                "The Python environment was not created. See bookvoice_setup.log.",
            )
            return None

    # If NVIDIA GPU exists but torch is still CPU-only, fix in place.
    if shutil.which("nvidia-smi") and not _venv_cuda_ok(venv_python):
        set_status(
            window,
            "Enabling GPU",
            "Installing CUDA PyTorch for your NVIDIA GPU (one-time, large download)…",
        )
        fix_src = os.path.join(app_dir, "fix_cuda_torch.bat")
        if not os.path.isfile(fix_src):
            fix_src = os.path.join(data_dir, "fix_cuda_torch.bat")
        if os.path.isfile(fix_src):
            fix_log = os.path.join(data_dir, "bookvoice_cuda_fix.log")
            try:
                # Pass absolute path to venv python as arg1
                creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
                with open(fix_log, "w", encoding="utf-8", errors="replace") as log:
                    subprocess.run(
                        ["cmd", "/c", fix_src, venv_python],
                        cwd=data_dir,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        check=False,
                        creationflags=creationflags,
                    )
            except Exception as e:
                print(f"[launch] CUDA fix failed: {e}")
        if not _venv_cuda_ok(venv_python):
            print(
                "[launch] WARNING: still no CUDA after fix. TTS will be very slow on CPU."
            )
            set_status(
                window,
                "GPU unavailable",
                "Continuing on CPU (slow). See bookvoice_cuda_fix.log.",
            )
            time.sleep(2)

    return venv_python


def show_error(window, message, log_path=None):
    detail = ""
    if log_path and os.path.exists(log_path):
        try:
            with open(log_path, "r", errors="ignore") as f:
                lines = f.read().splitlines()[-20:]
            detail = "\n".join(lines)
        except Exception:
            pass
    escaped = (message + "\n\n" + detail).replace("\\", "\\\\").replace("`", "\\`").replace(
        "\n", "\\n"
    )
    html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
        body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#14110f;color:#e5e5e5;padding:2rem;}}
        h2{{color:#f87171;font-weight:500;}} pre{{background:#1f1b18;border:1px solid #333;padding:1rem;border-radius:6px;white-space:pre-wrap;color:#fca5a5;font-size:12px;}}
        </style></head><body><h2>BookVoice failed to start</h2><pre>{escaped}</pre></body></html>"""
    try:
        window.load_html(html)
    except Exception:
        pass


def validate_app_dir(app_dir: str) -> str | None:
    """Return an error string if the app package is incomplete."""
    if not os.path.isfile(os.path.join(app_dir, "main.py")):
        return f"main.py missing in:\n{app_dir}"
    if not os.path.isdir(os.path.join(app_dir, "static")):
        return f"static/ missing in:\n{app_dir}\nRebuild with: python build.py"
    if not os.path.isfile(os.path.join(app_dir, "static", "index.html")):
        return "static/index.html missing — frontend was not packaged."
    models = os.path.join(app_dir, "data", "models", "en", "tokenizer.json")
    if not os.path.isfile(models):
        return (
            "English TTS model weights missing (data/models/en/).\n"
            "Run python build.py from the full source tree so models are copied into dist/."
        )
    return None


def main():
    app_dir = resolve_app_dir()
    data_dir = resolve_data_dir(app_dir)
    os.makedirs(data_dir, exist_ok=True)

    venv_python_path = _venv_python(data_dir)
    venv_status = "exists" if os.path.exists(venv_python_path) else "missing"
    chatterbox_ok = "yes" if _venv_has_chatterbox(data_dir) else "no"
    print(f"[launch] app_dir  = {app_dir}")
    print(f"[launch] data_dir = {data_dir}")
    print(f"[launch] venv     = {venv_status} (chatterbox: {chatterbox_ok})")
    print(f"[launch] frozen   = {getattr(sys, 'frozen', False)}")

    package_error = validate_app_dir(app_dir)

    seed_default_voices(app_dir, data_dir)
    os.chdir(app_dir)

    port = find_available_port(8000, 8020)
    if port is None:
        port = 8000

    html_content = """
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Loading BookVoice...</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: #14110f; color: #e5e5e5; display: flex; align-items: center;
                justify-content: center; height: 100vh; margin: 0; }
            .loader { border: 3px solid rgba(255,255,255,0.1); border-top: 3px solid #c9956b;
                border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite;
                margin: 0 auto 1.5rem auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .container { text-align: center; max-width: 28rem; padding: 1rem; }
            h2 { font-weight: 500; font-size: 1.2rem; letter-spacing: 0.5px; margin: 0; }
            p { color: #9ca3af; font-size: 0.9rem; margin-top: 0.5rem; line-height: 1.45; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="loader"></div>
            <h2 id="title">Starting BookVoice</h2>
            <p id="detail">Preparing the AI engine…</p>
        </div>
    </body>
    </html>
    """

    window = webview.create_window("BookVoice", html=html_content, width=1280, height=800)
    process = None
    setup_done = threading.Event()
    setup_error = {"msg": None}

    def start_server():
        nonlocal process
        try:
            if package_error:
                setup_error["msg"] = package_error
                setup_done.set()
                show_error(window, package_error)
                return

            set_status(window, "Checking environment", "Looking for Python packages…")
            venv_python = ensure_venv(app_dir, data_dir, window)
            if not venv_python:
                setup_error["msg"] = "venv setup failed"
                setup_done.set()
                return

            set_status(window, "Starting AI Engine", "Launching backend on localhost…")
            env = os.environ.copy()
            # Writable runtime data (sessions, voices)
            env["DATA_DIR"] = os.path.join(data_dir, "data")
            env["DEFAULT_VOICES_DIR"] = os.path.join(app_dir, "data", "default_voices")
            # Bundled model weights live next to the app (install dir / dist)
            env["MODEL_DIR"] = os.path.join(app_dir, "data", "models")
            env["APP_DIR"] = app_dir

            log_path = os.path.join(data_dir, "bookvoice_server.log")
            cmd = [
                venv_python,
                "-m",
                "uvicorn",
                "main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ]
            creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            log_file = open(log_path, "w", encoding="utf-8", errors="replace")
            process = subprocess.Popen(
                cmd,
                cwd=app_dir,
                env=env,
                creationflags=creationflags,
                stdout=log_file,
                stderr=subprocess.STDOUT,
            )
            process._bookvoice_log = log_file
        except Exception as e:
            setup_error["msg"] = str(e)
            show_error(window, f"Failed to start backend: {e}")
        finally:
            setup_done.set()

    threading.Thread(target=start_server, daemon=True).start()

    def check_server():
        # Wait while setup runs (can be 10–30+ minutes on first CUDA install)
        setup_seconds = 0
        while not setup_done.is_set():
            time.sleep(1)
            setup_seconds += 1
            if setup_seconds % 10 == 0:
                set_status(
                    window,
                    "First-time setup",
                    f"Still installing… {setup_seconds}s elapsed (CUDA download can take a while).",
                )
            if setup_seconds > 3600:
                show_error(
                    window,
                    "Setup timed out after 1 hour. See bookvoice_setup.log.",
                    os.path.join(data_dir, "bookvoice_setup.log"),
                )
                return

        if setup_error["msg"] and process is None:
            return

        # Process should exist now; wait for HTTP ready
        server_seconds = 0
        log_path = os.path.join(data_dir, "bookvoice_server.log")
        while server_seconds < 600:
            time.sleep(1)
            server_seconds += 1
            if process is None:
                show_error(window, "Backend process was not started.", log_path)
                return
            if process.poll() is not None:
                show_error(window, "The backend process exited unexpectedly.", log_path)
                return
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(1)
                    s.connect(("127.0.0.1", port))
                window.load_url(f"http://127.0.0.1:{port}")
                return
            except (ConnectionRefusedError, socket.timeout, OSError):
                if server_seconds % 15 == 0:
                    set_status(
                        window,
                        "Starting AI Engine",
                        f"Waiting for backend… ({server_seconds}s)",
                    )
        show_error(
            window,
            f"Backend did not become ready on port {port} after 600s.",
            log_path,
        )

    threading.Thread(target=check_server, daemon=True).start()

    webview.start()

    try:
        if process is not None:
            process.terminate()
            process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
    except Exception:
        pass
    finally:
        log_handle = getattr(process, "_bookvoice_log", None) if process else None
        if log_handle is not None:
            try:
                log_handle.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
