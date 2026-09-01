"""
BookVoice development launcher.

This is a thin, PyInstaller-friendly entry point for running BookVoice from a
source checkout. Unlike dist/Launcher.exe (which requires the full packaged
payload with an embedded Python worker), this launcher uses the system Python
to run the backend directly from the repo root.

It reuses launch.py's runtime resolution, env construction, and webview/tray
logic — it only swaps the worker: instead of the packaged runtime, it uses the
Python interpreter that built it (or BOOKVOICE_DEV_PYTHON).

Build the exe:
    python -m PyInstaller --noconfirm --clean BookVoice-Dev.spec
    # -> dist/BookVoice-Dev.exe
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

# Make the repo root importable so `import launch` works when frozen.
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import launch

try:
    import webview
except ImportError:
    webview = None


def resolve_dev_python() -> str | None:
    """Use the system Python (or BOOKVOICE_DEV_PYTHON) to run the backend."""
    env_python = os.environ.get("BOOKVOICE_DEV_PYTHON", "").strip()
    if env_python and Path(env_python).is_file():
        return env_python
    # Prefer the interpreter that built this exe; fall back to PATH python.
    candidates = [sys.executable, "python", "python3"]
    for c in candidates:
        found = shutil.which(c) if os.sep in c or not c.startswith(sys.executable) else c
        if found and Path(found).is_file():
            return found
    return None


def dev_worker(app_dir: str, log: launch.Logger) -> str | None:
    """Resolve a Python for the backend; dev uses the system interpreter."""
    py = resolve_dev_python()
    if not py:
        return None
    # Verify it can import fastapi/uvicorn — the backend needs them.
    try:
        r = subprocess.run(
            [py, "-c", "import fastapi, uvicorn"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            log.write(f"{py} lacks fastapi/uvicorn: {r.stderr.strip()[:200]}")
            return None
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.write(f"could not probe {py}: {exc}")
        return None
    return py


def main(argv: list[str] | None = None) -> int:
    args = launch.parse_args(argv)
    app_dir = launch.resolve_app_dir()
    runtime_dir = launch.resolve_runtime_dir(app_dir)
    os.makedirs(runtime_dir, exist_ok=True)
    log = launch.Logger(launch._log_path(runtime_dir, app_dir))
    log.write("==== dev launch start ====")
    log.write(f"version={launch.read_app_version(app_dir)}")
    log.write(f"frozen={getattr(sys, 'frozen', False)}")
    log.write(f"app_dir={app_dir}")
    log.write(f"runtime_dir={runtime_dir}")

    err = launch.validate_package(app_dir)
    if err:
        # Dev mode is lenient: static/index.html may not be built yet.
        # Only hard-fail if main.py itself is missing.
        if "main.py missing" in err:
            log.write(f"package invalid: {err}")
            launch.show_error(None, err, log.path)
            return 1
        log.write(f"dev note: {err}")

    voices_dir = launch.resolve_voices_dir(app_dir, runtime_dir)
    try:
        migrated = launch.migrate_voice_library(app_dir, runtime_dir, voices_dir, log)
        if migrated:
            log.write(f"recovered {migrated} voice library file(s)")
    except OSError as exc:
        log.write(f"voice library recovery will retry later: {exc}")

    launch.clear_pycache(app_dir)
    launch.seed_voices(app_dir, voices_dir)
    os.chdir(app_dir)

    py = dev_worker(app_dir, log)
    if not py:
        msg = (
            "No suitable Python with fastapi/uvicorn found. "
            "Set BOOKVOICE_DEV_PYTHON to your repo venv interpreter."
        )
        log.write(msg)
        launch.show_error(None, msg, log.path)
        return 1

    log.write(f"dev worker python: {py}")

    use_webview = webview is not None and not args.browser and not args.no_window
    window = None
    tray_controller = None

    if use_webview:
        launch.configure_webview_gpu()
        launch.configure_webview_downloads(webview)
        window = launch.create_main_window(webview, app_dir)
        tray_controller = launch.configure_system_tray(window, app_dir, log)

    state: dict = {"error": None}
    tunnel_handle: dict = {}

    def worker() -> None:
        try:
            def status(title: str, detail: str, progress: int | None = None) -> None:
                launch.set_status(window, title, detail, progress)
                log.write(f"status: {title} | {detail}")

            status("Checking runtime", "Verifying the development Python…", 12)

            launch.kill_stale_servers(app_dir, runtime_dir, log)
            bind_host = launch.resolve_bind_host(args.host)
            port = launch.pick_port(log, bind_host, launch.resolve_pinned_port(args.port))
            env = launch.apply_network_env(launch.build_env(app_dir, runtime_dir), bind_host)

            status("Preparing local service", "Selecting a private local address…", 30)
            log.write(f"python={py}")
            log.write(f"port={port}")
            log.write(f"bind={bind_host}")

            tunnel_settings = launch.tunnel.resolve_settings(runtime_dir, {
                "mode": args.tunnel,
                "name": args.tunnel_name,
                "hostname": args.tunnel_hostname,
                "token": args.tunnel_token,
            })
            if launch.tunnel.is_enabled(tunnel_settings):
                status("Opening tunnel", "Publishing BookVoice over Cloudflare…", 42)
                try:
                    active_tunnel = launch.tunnel.start_tunnel(
                        tunnel_settings, port, runtime_dir, log=log,
                    )
                    tunnel_handle["tunnel"] = active_tunnel
                    env = launch.apply_tunnel_env(env, active_tunnel.url)
                    log.write(f"tunnel ready at {active_tunnel.url}")
                except Exception as exc:
                    status("Tunnel unavailable", str(exc), 46)
                    log.write(f"tunnel failed: {exc}")

            status("Starting backend", "Launching the BookVoice reading engine…", 60)
            cmd = [
                py, "-m", "uvicorn", "main:app",
                "--host", bind_host, "--port", str(port),
                "--reload", "--reload-dir", str(HERE / "backend"),
            ]
            log.write(f"cmd: {' '.join(cmd)}")

            log_file_path = os.path.join(runtime_dir, "bookvoice_backend.log")
            log_file = open(log_file_path, "a", encoding="utf-8", errors="replace")
            process = subprocess.Popen(
                cmd, env={**os.environ, **env},
                stdout=log_file, stderr=subprocess.STDOUT,
                creationflags=launch._no_window(),
            )

            def wait_ready(timeout_s: float = 60.0, interval: float = 1.0) -> tuple[bool, str]:
                """Poll health until the backend answers, mirroring launch.py's loop.

                Both early exits matter as much as the success case: a backend
                that dies on startup and a TTS model that fails to load would
                otherwise both sit here burning the full timeout and then
                report the same generic "did not start", hiding the real cause
                in the log.
                """
                base_url = f"http://{bind_host}:{port}"
                deadline = time.monotonic() + timeout_s
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        return False, "Backend exited early. See log:\n" + log_file_path
                    ready, detail, failed = launch.backend_readiness(base_url)
                    if ready:
                        return True, detail
                    if failed:
                        return False, f"TTS model failed to load: {detail}"
                    time.sleep(interval)
                return False, "Backend did not start. See log:\n" + log_file_path

            status("Waiting for backend", "Connecting to the reading engine…", 80)
            ready, reason = wait_ready()
            if not ready:
                state["error"] = reason
                log.write(reason)
                launch.show_error(window, state["error"], log_file_path)
                return

            status("Ready", "Opening BookVoice…", 100)
            url = f"http://{bind_host}:{port}"
            if use_webview:
                webview.load_url(url)
            else:
                webbrowser.open(url)

            # Keep the thread alive while the process runs.
            process.wait()
        except Exception as exc:
            state["error"] = str(exc)
            log.write(f"dev launch error: {exc}")
            launch.show_error(window, state["error"], log.path)
        finally:
            if tray_controller:
                try:
                    tray_controller.stop()
                except Exception:
                    pass

    import threading
    t = threading.Thread(target=worker, daemon=True)
    t.start()

    if use_webview:
        try:
            webview.start()
        except Exception as exc:
            log.write(f"webview error: {exc}")
        return 0 if state["error"] is None else 1

    # Browser mode: wait for the backend thread, then exit.
    try:
        while t.is_alive():
            t.join(timeout=1)
    except KeyboardInterrupt:
        log.write("interrupted")
    return 0 if state["error"] is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
