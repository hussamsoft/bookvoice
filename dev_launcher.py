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
import urllib.parse
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


def dev_python_candidates() -> list[str]:
    """Interpreters that could run the backend, best first.

    The repo venv comes first: it carries the real reading engine (CUDA torch
    and chatterbox), while the interpreter running this shell only needs
    pywebview. The two are deliberately allowed to differ.
    """
    raw = [os.environ.get("BOOKVOICE_DEV_PYTHON", "").strip()]
    for rel in (
        ("backend", ".venv", "Scripts", "python.exe"),
        ("backend", ".venv", "bin", "python"),
        (".venv", "Scripts", "python.exe"),
        (".venv", "bin", "python"),
    ):
        raw.append(str(HERE.joinpath(*rel)))
    raw.append(sys.executable)
    raw.extend(shutil.which(name) or "" for name in ("python", "python3"))

    ordered: list[str] = []
    seen: set[str] = set()
    for candidate in raw:
        if not candidate or not Path(candidate).is_file():
            continue
        key = os.path.normcase(os.path.abspath(candidate))
        if key in seen:
            continue
        seen.add(key)
        ordered.append(candidate)
    return ordered


def dev_worker(log: launch.Logger) -> str | None:
    """The first candidate interpreter that can actually import the web stack."""
    candidates = dev_python_candidates()
    log.write(f"dev python candidates: {candidates}")
    for py in candidates:
        try:
            r = subprocess.run(
                [py, "-c", "import fastapi, uvicorn"],
                capture_output=True, text=True, timeout=60,
                creationflags=launch._no_window(),
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            log.write(f"could not probe {py}: {exc}")
            continue
        if r.returncode == 0:
            return py
        log.write(f"{py} lacks fastapi/uvicorn: {r.stderr.strip()[:200]}")
    return None


def stop_backend_tree(process, log: launch.Logger) -> None:
    """Terminate the backend and anything it spawned; safe to call twice.

    Without this a closed window leaves uvicorn holding the port, and the next
    run either picks a different port or trips over the orphan.
    """
    if process is None or process.poll() is not None:
        return
    children = []
    if launch.psutil is not None:
        try:
            children = launch.psutil.Process(process.pid).children(recursive=True)
        except Exception:
            children = []
    for child in children:
        try:
            child.terminate()
        except Exception:
            pass
    try:
        process.terminate()
        process.wait(timeout=5)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass
    for child in children:
        try:
            if child.is_running():
                child.kill()
        except Exception:
            pass
    log.write("backend stopped")


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

    py = dev_worker(log)
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
        window = launch.create_main_window(
            webview, app_dir, phone_view=bool(args.phone_view)
        )
        tray_controller = launch.configure_system_tray(window, app_dir, log)

    state: dict = {"error": None}
    tunnel_handle: dict = {}
    backend: dict = {"process": None}

    def worker() -> None:
        try:
            def status(title: str, detail: str, progress: int | None = None) -> None:
                launch.set_status(window, title, detail, progress)
                log.write(f"status: {title} | {detail}")

            status("Checking runtime", "Verifying the development Python…", 12)

            launch.kill_stale_servers(
                app_dir, runtime_dir, log,
                extra_markers=(os.path.dirname(py),),
            )
            bind_host = launch.resolve_bind_host(args.host)
            allow_lan = bool(args.allow_lan) or launch.lan_opt_in_env()
            pinned = launch.resolve_pinned_port(args.port)
            try:
                port = launch.pick_port(log, bind_host, pinned)
            except launch.PortUnavailable as exc:
                state["error"] = str(exc)
                log.write(f"fatal: {state['error']}")
                launch.show_error(window, state["error"], log.path)
                return
            status("Preparing local service", "Selecting a private local address…", 30)
            log.write(f"python={py}")
            log.write(f"port={port}")
            log.write(f"bind={bind_host}")

            env = launch.apply_network_env(
                launch.build_env(app_dir, runtime_dir),
                bind_host,
                allow_lan=allow_lan,
            )
            log_file_path = os.path.join(runtime_dir, "bookvoice_server.log")

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

            def uvicorn_cmd(candidate: int) -> list[str]:
                cmd = [py, "-m", "uvicorn", "main:app",
                       "--host", bind_host, "--port", str(candidate)]
                # Off by default: the reloader forks a second process that
                # outlives a terminate() of the parent and keeps the port, and
                # UAT runs exercise the app rather than edit it mid-session.
                if str(os.environ.get("BOOKVOICE_DEV_RELOAD", "")).strip().lower() in {
                    "1", "true", "yes", "on",
                }:
                    cmd += ["--reload", "--reload-dir", app_dir]
                return cmd

            def spawn_dev(candidate: int):
                handle = open(log_file_path, "w", encoding="utf-8", errors="replace")
                proc = subprocess.Popen(
                    uvicorn_cmd(candidate),
                    cwd=app_dir,
                    env=env,
                    stdout=handle, stderr=subprocess.STDOUT,
                    creationflags=launch._no_window(),
                )
                backend["process"] = proc
                return proc, handle

            try:
                process, log_file = spawn_dev(port)
            except OSError as exc:
                state["error"] = f"Could not start the reading service on port {port}: {exc}"
                log.write(f"fatal: {state['error']}")
                launch.show_error(window, state["error"], log_file_path)
                return
            start_time = time.monotonic()
            log.write(f"cmd: {' '.join(uvicorn_cmd(port))}")
            excluded = [port]
            while True:
                time.sleep(0.5)
                if process.poll() is None:
                    break
                if pinned or time.monotonic() - start_time > launch.STEAL_WINDOW_S:
                    state["error"] = "Backend exited early. See log:\n" + log_file_path
                    log.write(state["error"])
                    launch.show_error(window, state["error"], log_file_path)
                    return
                if not launch.port_stolen(bind_host, port, log_file_path):
                    state["error"] = "Backend exited early. See log:\n" + log_file_path
                    log.write(state["error"])
                    launch.show_error(window, state["error"], log_file_path)
                    return
                log.write(f"port {port} was taken between scan and bind; scanning again")
                try:
                    log_file.close()
                except OSError:
                    pass
                try:
                    port = launch.pick_port(log, bind_host, 0, exclude=tuple(excluded))
                except launch.PortUnavailable as exc:
                    state["error"] = str(exc)
                    log.write(f"fatal: {state['error']}")
                    launch.show_error(window, state["error"], log_file_path)
                    return
                excluded.append(port)
                try:
                    process, log_file = spawn_dev(port)
                except OSError as exc:
                    state["error"] = f"Could not start the reading service on port {port}: {exc}"
                    log.write(f"fatal: {state['error']}")
                    launch.show_error(window, state["error"], log_file_path)
                    return
                start_time = time.monotonic()

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

            open_host = bind_host if launch.is_loopback_host(bind_host) else "127.0.0.1"
            url = f"http://{open_host}:{port}"
            if not launch.is_loopback_host(bind_host):
                for address in launch.lan_addresses():
                    log.write(f"reachable on this network at http://{address}:{port}")
            params = {"shell": "native"} if window is not None else {}
            open_url = f"{url}/?{urllib.parse.urlencode(params)}" if params else url
            if args.no_window:
                status("Ready", f"Backend ready at {url}", 100)
                log.write(f"backend ready (--no-window) at {url}")
            elif window is not None:
                status("Ready", "Opening BookVoice…", 100)
                window.load_url(open_url)
            else:
                status("Ready", "Opening BookVoice…", 100)
                log.write(f"opening browser at {open_url}")
                webbrowser.open(open_url)

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
            active = tunnel_handle.get("tunnel")
            if active is not None:
                try:
                    active.stop()
                except Exception:
                    pass

    import threading
    t = threading.Thread(target=worker, daemon=True)
    t.start()

    try:
        if use_webview:
            try:
                webview.start()
            except Exception as exc:
                log.write(f"webview error: {exc}")
        else:
            # Browser / headless mode: hold the console until the backend ends.
            while t.is_alive():
                t.join(timeout=1)
    except KeyboardInterrupt:
        log.write("interrupted")
    finally:
        stop_backend_tree(backend.get("process"), log)
    return 0 if state["error"] is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
