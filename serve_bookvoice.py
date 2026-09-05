"""BookVoice headless server console.

Serves the same backend the desktop shell uses over HTTP without opening any
window, so another device (a phone or tablet on the same network) can use
BookVoice in its browser while the desktop app stays closed. The Windows
desktop shell (desktop/BookVoice.App) also spawns this script as its backend
process and reads ``server-state.json`` from the runtime directory to learn
the selected port and readiness phase.

Startup mirrors launch.main(): package validation, voice-library recovery and
seeding, stale-server cleanup, port scan, then the packaged worker running
``uvicorn main:app``. A watchdog restarts the backend after a sustained health
failure — the same failure mode launch.py guards (a LAN client aborting a
connection mid-accept can kill uvicorn's Windows accept loop).
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request

if str(os.path.dirname(os.path.abspath(__file__))) not in sys.path:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import launch

STATE_SCHEMA = 1
READY_TIMEOUT_S = 300
WATCH_INTERVAL_S = 5
HEALTH_MISS_LIMIT = 6
MAX_RESTARTS = 5


def emit(message: str) -> None:
    """Print that keeps working under pythonw, where sys.stdout is None."""
    if sys.stdout is None:
        return
    try:
        print(message, flush=True)
    except OSError:
        pass


def write_state(runtime_dir: str, **payload) -> None:
    """Publish launcher state for the desktop shell; atomic per write."""
    path = os.path.join(runtime_dir, "server-state.json")
    payload.setdefault("schema", STATE_SCHEMA)
    payload.setdefault("pid", os.getpid())
    tmp = path + f".{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
            handle.write("\n")
        os.replace(tmp, path)
    except OSError:
        pass


def resolve_backend_python(app_dir: str, log: launch.Logger) -> tuple[str | None, str | None]:
    """The packaged worker, or the running interpreter in a source checkout."""
    py = launch.packaged_worker(app_dir, log)
    if py:
        return py, None
    try:
        import importlib.util

        missing = [
            name
            for name in ("fastapi", "uvicorn")
            if importlib.util.find_spec(name) is None
        ]
    except (ImportError, ValueError):
        missing = ["backend packages"]
    if not missing:
        return sys.executable, None
    return None, (
        "runtime/worker/python.exe is missing (rebuild with `python build.py`), "
        f"and this interpreter cannot serve the backend either (missing: {', '.join(missing)})."
    )


def start_backend(cmd: list[str], app_dir: str, env: dict, log: launch.Logger):
    process = subprocess.Popen(
        cmd,
        cwd=app_dir,
        env=env,
        creationflags=launch._no_window(),
    )
    log.write(f"started pid={process.pid} cmd={' '.join(cmd)}")
    return process


def stop_backend(process) -> None:
    """Terminate the backend process tree; safe to call repeatedly."""
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
    except OSError:
        return
    try:
        process.wait(timeout=3)
    except Exception:
        try:
            process.kill()
        except OSError:
            pass


def wait_ready(process, base_url: str) -> str | None:
    """Poll /api/health until ready; return a failure reason or None."""
    for i in range(READY_TIMEOUT_S):
        if process.poll() is not None:
            return f"the reading service exited early (code {process.returncode})"
        if launch.backend_readiness(base_url)[0]:
            return None
        if i and i % 10 == 0:
            emit(f"Still starting the reading engine… ({i}s; first start can take a while)")
        time.sleep(1)
    return "the reading service did not become ready in time"


def print_banner(host: str, port: int, env: dict) -> None:
    emit("")
    emit("BookVoice is running")
    emit("")
    emit(f"  On this PC:       http://127.0.0.1:{port}")
    if not launch.is_loopback_host(host):
        for address in launch.lan_addresses():
            emit(
                f"  On your network:  http://{address}:{port}"
                "   <- open this on your phone or tablet"
            )
        if not env.get("BOOKVOICE_ACCESS_PASSWORD"):
            emit("")
            emit(
                "  NOTE: anyone on this network can open BookVoice while it runs. "
                "Set BOOKVOICE_ACCESS_PASSWORD to require a sign-in."
            )
    emit("")
    emit("Keep this window open. Press Ctrl+C to stop the server.")
    emit("")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Serve BookVoice over the network without the desktop window. "
            "Most people should use Start-BookVoice-Server.bat instead of "
            "calling this directly; the desktop shell passes its own defaults."
        )
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
        "--port",
        type=int,
        default=None,
        help="Pin the local port instead of scanning 8000-8020.",
    )
    parser.add_argument(
        "book_path",
        nargs="?",
        default=None,
        help="A .bookvoice archive to import once the server is ready.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    app_dir = launch.resolve_app_dir()
    runtime_dir = launch.resolve_runtime_dir(app_dir)
    os.makedirs(runtime_dir, exist_ok=True)
    log = launch.Logger(launch._log_path(runtime_dir, app_dir))
    log.write("==== server start ====")
    log.write(f"app_dir={app_dir}")
    log.write(f"runtime_dir={runtime_dir}")
    try:
        os.remove(os.path.join(runtime_dir, "server-state.json"))
    except OSError:
        pass
    write_state(runtime_dir, state="starting", host=None, port=None)

    def fail(message: str) -> int:
        log.write(f"fatal: {message}")
        write_state(runtime_dir, state="error", error=message)
        emit(f"BookVoice could not start: {message}")
        return 1

    err = launch.validate_package(app_dir)
    if err:
        return fail(err)

    py, worker_error = resolve_backend_python(app_dir, log)
    if py is None:
        return fail(worker_error or "no usable backend runtime")

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

    launch.kill_stale_servers(app_dir, runtime_dir, log)
    bind_host = launch.resolve_bind_host(args.host)
    port = launch.pick_port(log, bind_host, launch.resolve_pinned_port(args.port))
    env = launch.apply_network_env(launch.build_env(app_dir, runtime_dir), bind_host)
    log.write(f"bind={bind_host} port={port}")
    write_state(runtime_dir, state="starting", host=bind_host, port=port)

    cmd = [py, "-m", "uvicorn", "main:app", "--host", bind_host, "--port", str(port)]
    process = start_backend(cmd, app_dir, env, log)
    base_url = f"http://127.0.0.1:{port}"
    restarts = 0
    book_id = None

    def restart_backend(reason: str) -> bool:
        nonlocal restarts, process
        if restarts >= MAX_RESTARTS:
            return False
        restarts += 1
        log.write(f"watchdog: {reason}; restart {restarts}/{MAX_RESTARTS}")
        emit(f"The reading service stopped responding; restarting ({restarts}/{MAX_RESTARTS})…")
        stop_backend(process)
        write_state(runtime_dir, state="starting", host=bind_host, port=port)
        process = start_backend(cmd, app_dir, env, log)
        return True

    try:
        while True:
            failure = wait_ready(process, base_url)
            if failure is not None:
                if not restart_backend(failure):
                    return fail(f"{failure}; gave up after {MAX_RESTARTS} restarts")
                continue

            if args.book_path and book_id is None:
                try:
                    book_id = launch.import_prepared_book(base_url, args.book_path)
                    log.write(f"imported prepared book {book_id}")
                except (ValueError, OSError) as exc:
                    emit(f"Could not import the prepared book: {exc}")

            write_state(
                runtime_dir,
                state="ready",
                host=bind_host,
                port=port,
                book=book_id,
                serverPid=process.pid,
            )
            print_banner(bind_host, port, env)

            reason = None
            misses = 0
            while reason is None:
                time.sleep(WATCH_INTERVAL_S)
                if process.poll() is not None:
                    reason = f"the reading service exited (code {process.returncode})"
                elif launch.backend_readiness(base_url)[0]:
                    misses = 0
                else:
                    misses += 1
                    if misses >= HEALTH_MISS_LIMIT:
                        reason = "the reading service stopped answering health checks"
            if not restart_backend(reason):
                return fail(f"{reason}; gave up after {MAX_RESTARTS} restarts")
    except KeyboardInterrupt:
        emit("Stopping BookVoice…")
    finally:
        stop_backend(process)
        try:
            os.remove(os.path.join(runtime_dir, "server-state.json"))
        except OSError:
            pass
        write_state(runtime_dir, state="stopped")
        log.write("==== server end ====")
    return 0


def install_signals() -> None:
    """Turn Ctrl+C and console-close signals into a clean KeyboardInterrupt.

    SIGBREAK arrives when the console window closes or the process group gets
    CTRL_BREAK; both should stop the server rather than die mid-write.
    """
    def handler(signum, frame):  # noqa: ARG001 - signal handler signature
        raise KeyboardInterrupt

    for name in ("SIGINT", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):
                pass


if __name__ == "__main__":
    install_signals()
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except SystemExit:
        raise
    except Exception:  # pragma: no cover - last-resort report
        traceback.print_exc()
        raise SystemExit(1)
