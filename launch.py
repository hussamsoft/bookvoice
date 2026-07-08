import subprocess
import webview
import time
import sys
import os
import socket
import psutil
import threading
import shutil
APP_NAME = "BookVoice"


def get_listening_pid(port):
    try:
        for conn in psutil.net_connections(kind='inet'):
            if conn.laddr.port == port and conn.status == 'LISTEN':
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
                    s.bind(('0.0.0.0', port))
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


def _app_dir_frozen():
    exe_dir = os.path.dirname(sys.executable)
    if os.path.isfile(os.path.join(exe_dir, "main.py")) and os.path.isdir(os.path.join(exe_dir, "static")):
        return os.path.abspath(exe_dir)
    for base in (sys._MEIPASS, exe_dir):
        if not base:
            continue
        candidate = os.path.join(base, "dist")
        if os.path.isfile(os.path.join(candidate, "main.py")) and os.path.isdir(os.path.join(candidate, "static")):
            return os.path.abspath(candidate)
        if os.path.isfile(os.path.join(base, "main.py")) and os.path.isdir(os.path.join(base, "static")):
            return os.path.abspath(base)
    return os.path.abspath(exe_dir)


def resolve_app_dir():
    if getattr(sys, 'frozen', False):
        return _app_dir_frozen()

    application_path = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        application_path,
        os.path.join(application_path, "dist"),
        os.path.join(os.path.dirname(application_path), "dist"),
        os.path.join(application_path, "backend"),
        os.path.join(os.path.dirname(application_path), "backend"),
    ]
    for c in candidates:
        c = os.path.abspath(c)
        if os.path.isfile(os.path.join(c, "main.py")) and os.path.isdir(os.path.join(c, "static")):
            return c
    for c in candidates:
        c = os.path.abspath(c)
        if os.path.isfile(os.path.join(c, "main.py")):
            return c
    return os.path.abspath(application_path)


def _is_dir_writable(directory):
    try:
        probe = os.path.join(directory, ".bookvoice_writable_test")
        with open(probe, "w") as f:
            f.write("test")
        os.remove(probe)
        return True
    except (OSError, PermissionError):
        return False


def resolve_data_dir(app_dir):
    if _is_dir_writable(app_dir):
        return app_dir
    base = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
    return os.path.join(base, APP_NAME)


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


def ensure_venv(app_dir, data_dir, window):
    venv_python = os.path.join(data_dir, ".venv", "Scripts", "python.exe")
    if os.path.exists(venv_python):
        return venv_python

    set_status(window, "First-time setup", "Installing dependencies (this can take several minutes)...")

    req_src = os.path.join(app_dir, "requirements.txt")
    if not os.path.isfile(req_src):
        set_status(window, "Setup failed", "requirements.txt not found in app directory.")
        return None

    os.makedirs(data_dir, exist_ok=True)
    shutil.copy2(req_src, os.path.join(data_dir, "requirements.txt"))

    setup_script = os.path.join(app_dir, "setup_venv.bat")
    log_path = os.path.join(data_dir, "bookvoice_setup.log")
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    try:
        with open(log_path, "w") as log:
            subprocess.run(
                setup_script,
                cwd=data_dir,
                stdout=log,
                stderr=subprocess.STDOUT,
                shell=True,
                check=True,
                creationflags=creationflags,
            )
    except Exception as e:
        set_status(window, "Setup failed", f"Could not create the Python environment: {e}")
        return None

    if not os.path.exists(venv_python):
        set_status(window, "Setup failed", "The Python environment was not created. See bookvoice_setup.log.")
        return None
    return venv_python


def show_error(window, message, log_path=None):
    detail = ""
    if log_path and os.path.exists(log_path):
        try:
            with open(log_path, "r", errors="ignore") as f:
                lines = f.read().splitlines()[-15:]
            detail = "\n".join(lines)
        except Exception:
            pass
    escaped = (message + "\n\n" + detail).replace("\\", "\\\\").replace("`", "\\`").replace("\n", "\\n")
    html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
        body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#14110f;color:#e5e5e5;padding:2rem;}}
        h2{{color:#f87171;font-weight:500;}} pre{{background:#1f1b18;border:1px solid #333;padding:1rem;border-radius:6px;white-space:pre-wrap;color:#fca5a5;font-size:12px;}}
        </style></head><body><h2>BookVoice failed to start</h2><pre>{escaped}</pre></body></html>"""
    try:
        window.load_html(html)
    except Exception:
        pass


def main():
    app_dir = resolve_app_dir()
    data_dir = resolve_data_dir(app_dir)
    os.makedirs(data_dir, exist_ok=True)

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
            .loader { border: 3px solid rgba(255,255,255,0.1); border-top: 3px solid #8b5cf6;
                border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite;
                margin: 0 auto 1.5rem auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .container { text-align: center; }
            h2 { font-weight: 500; font-size: 1.2rem; letter-spacing: 0.5px; margin: 0; }
            p { color: #9ca3af; font-size: 0.9rem; margin-top: 0.5rem; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="loader"></div>
            <h2 id="title">Starting AI Engine</h2>
            <p id="detail">Warming up Neural Voices...</p>
        </div>
    </body>
    </html>
    """

    window = webview.create_window('BookVoice', html=html_content, width=1280, height=800)
    process = None

    def start_server():
        nonlocal process
        venv_python = ensure_venv(app_dir, data_dir, window)
        if not venv_python:
            return
        set_status(window, "Starting AI Engine", "Warming up Neural Voices...")
        env = os.environ.copy()
        env["DATA_DIR"] = os.path.join(data_dir, "data")
        env["DEFAULT_VOICES_DIR"] = os.path.join(app_dir, "data", "default_voices")
        log_path = os.path.join(data_dir, "bookvoice_server.log")
        cmd = [venv_python, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", str(port)]
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        process = subprocess.Popen(
            cmd, cwd=app_dir, env=env, creationflags=creationflags,
            stdout=open(log_path, "w"), stderr=subprocess.STDOUT,
        )

    threading.Thread(target=start_server, daemon=True).start()

    def check_server():
        for _ in range(120):
            time.sleep(1)
            if process is None:
                continue
            if process.poll() is not None:
                log_path = os.path.join(data_dir, "bookvoice_server.log")
                show_error(window, "The backend process exited unexpectedly.", log_path)
                return
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(1)
                    s.connect(('127.0.0.1', port))
                window.load_url(f'http://127.0.0.1:{port}')
                return
            except (ConnectionRefusedError, socket.timeout, OSError):
                pass
        log_path = os.path.join(data_dir, "bookvoice_server.log")
        show_error(window, f"Backend did not become ready on port {port} after 120s.", log_path)

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


if __name__ == "__main__":
    main()
