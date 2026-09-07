"""BookVoice headless server console.

Serves the same backend the desktop shell uses over HTTP without opening any
window, so another device (a phone or tablet on the same network) can use
BookVoice in its browser while the desktop app stays closed. The Windows
desktop shell (desktop/BookVoice.App) also spawns this script as its backend
process and reads ``server-state.json`` from the runtime directory to learn
the selected port and readiness phase.

Startup mirrors launch.main(): package validation, voice-library recovery and
seeding, stale-server cleanup, port selection, then the packaged worker
running ``uvicorn main:app``. A watchdog restarts the backend after a
sustained health failure — the same failure mode launch.py guards (a LAN
client aborting a connection mid-accept can kill uvicorn's Windows accept
loop).

The port is dynamic but sticky: the port this install last came up ready on
is reused when free, so bookmarked phone URLs and dashboard-tunnel routing
survive restarts, and a fresh scan only happens when that port is genuinely
taken (or a port was pinned explicitly). ``DATA_DIR/server-access.json``
records where the server can be reached — LAN addresses and the Cloudflare
tunnel URL — for ``GET /api/server/addresses`` and the Settings card.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request

if str(os.path.dirname(os.path.abspath(__file__))) not in sys.path:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import launch
import tunnel

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


def write_json_atomic(path: str, payload: dict) -> None:
    tmp = path + f".{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
            handle.write("\n")
        os.replace(tmp, path)
    except OSError:
        pass


def write_state(runtime_dir: str, **payload) -> None:
    """Publish launcher state for the desktop shell; atomic per write."""
    payload.setdefault("schema", STATE_SCHEMA)
    payload.setdefault("pid", os.getpid())
    write_json_atomic(os.path.join(runtime_dir, "server-state.json"), payload)


def sticky_port(runtime_dir: str) -> int:
    """The port this install last came up ready on, if it is plausible."""
    try:
        with open(os.path.join(runtime_dir, "server-port.json"), encoding="utf-8") as handle:
            port = int(json.load(handle).get("port") or 0)
    except (OSError, ValueError, json.JSONDecodeError):
        return 0
    return port if 1 <= port <= 65535 else 0


def port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def choose_port(runtime_dir: str, bind_host: str, pinned: int, log: launch.Logger) -> tuple[int, str]:
    """Pick the port: explicit pin, then the sticky last-ready port, then scan.

    A pinned port never falls back (something is routed to it — see
    launch.pick_port). A sticky port falls back to the scan when busy, so a
    restart can never fail to find an address.
    """
    if pinned:
        return launch.pick_port(log, bind_host, pinned), "pinned"
    sticky = sticky_port(runtime_dir)
    if sticky and port_free(bind_host, sticky):
        log.write(f"reusing sticky port {sticky}")
        return sticky, "sticky"
    if sticky:
        log.write(f"previous port {sticky} is busy; scanning for another")
    return launch.pick_port(log, bind_host, 0), "scan"


def remember_port(runtime_dir: str, port: int) -> None:
    write_json_atomic(os.path.join(runtime_dir, "server-port.json"), {"port": port})


def write_access_file(
    data_dir: str, bind_host: str, port: int, tunnel_url: str, log: launch.Logger
) -> None:
    """Record where the server is reachable for GET /api/server/addresses."""
    lan = not launch.is_loopback_host(bind_host)
    payload = {
        "available": True,
        "host": bind_host,
        "port": port,
        "lan": lan,
        "addresses": launch.lan_addresses() if lan else [],
        "tunnelUrl": tunnel_url or "",
        "updatedAt": int(time.time()),
    }
    write_json_atomic(os.path.join(data_dir, "server-access.json"), payload)
    log.write(f"access file updated: port={port} lan={lan} tunnel={bool(tunnel_url)}")


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


def print_banner(host: str, port: int, tunnel_url: str, env: dict) -> None:
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
    if tunnel_url:
        emit(f"  Over Cloudflare:  {tunnel_url}")
        if not env.get("BOOKVOICE_ACCESS_PASSWORD"):
            emit("  NOTE: the tunnel is on the public internet; set BOOKVOICE_ACCESS_PASSWORD.")
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
        "--allow-lan",
        action="store_true",
        help=(
            "Required together with a non-loopback --host: lets browsers on "
            "the local network reach the app over plain HTTP."
        ),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help=(
            "Pin the local port instead of reusing the last one and scanning "
            "8000-8020. A dashboard tunnel's public hostname points at a "
            "specific localhost port, so pin it to match."
        ),
    )
    parser.add_argument(
        "--tunnel",
        nargs="?",
        const="cloudflare",
        default=None,
        help="Publish the server over Cloudflare Tunnel.",
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
            "Token for a tunnel created in the Cloudflare dashboard. Pair it "
            "with --port matching the public hostname you routed."
        ),
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
    allow_lan = bool(args.allow_lan) or launch.lan_opt_in_env()
    if not launch.is_loopback_host(bind_host) and not allow_lan:
        return fail(
            "Refusing a network-wide bind without --allow-lan. "
            "Pass --allow-lan (or BOOKVOICE_ALLOW_LAN=1) to expose "
            "the app to the local network."
        )
    port, port_source = choose_port(runtime_dir, bind_host, launch.resolve_pinned_port(args.port), log)
    env = launch.apply_network_env(
        launch.build_env(app_dir, runtime_dir), bind_host, allow_lan=allow_lan
    )
    write_state(runtime_dir, state="starting", host=bind_host, port=port)

    tunnel_handle = None
    tunnel_url = ""
    tunnel_settings = tunnel.resolve_settings(runtime_dir, {
        "mode": args.tunnel,
        "name": args.tunnel_name,
        "hostname": args.tunnel_hostname,
        "token": args.tunnel_token,
    })
    if tunnel.is_enabled(tunnel_settings):
        emit("Opening the Cloudflare tunnel…")
        try:
            tunnel_handle = tunnel.start_tunnel(tunnel_settings, port, runtime_dir, log=log)
            tunnel_url = tunnel_handle.url
            env = launch.apply_tunnel_env(env, tunnel_url)
            log.write(f"tunnel ready at {tunnel_url}")
            if not tunnel.is_named(tunnel_settings):
                emit(
                    "NOTE: this is a quick tunnel — Cloudflare issues a new "
                    "address every start. Use --tunnel-name and "
                    "--tunnel-hostname for a permanent one."
                )
            if tunnel.is_remote_managed(tunnel_settings):
                if port_source == "scan":
                    log.write(
                        "WARNING: a dashboard tunnel routes its public hostname "
                        f"to one fixed localhost port, but this start scanned and "
                        f"landed on {port}. Pass --port {port} (or BOOKVOICE_PORT) "
                        "to pin it, and point the dashboard's ingress there."
                    )
                if not env.get("BOOKVOICE_ACCESS_PASSWORD"):
                    log.write(
                        "WARNING: the tunnel is reachable from the public internet "
                        "with no BOOKVOICE_ACCESS_PASSWORD set."
                    )
            hostname_warning = tunnel.missing_hostname_warning(tunnel_settings)
            if hostname_warning:
                log.write(f"WARNING: {hostname_warning}")
                emit(f"WARNING: {hostname_warning}")
        except tunnel.TunnelError as exc:
            # The app is still perfectly usable locally, so this is reported
            # rather than treated as a failure to launch.
            log.write(f"tunnel unavailable: {exc}")
            emit(f"Tunnel unavailable: {exc}")
            tunnel_handle = None

    cmd = [py, "-m", "uvicorn", "main:app", "--host", bind_host, "--port", str(port)]
    process = start_backend(cmd, app_dir, env, log)
    base_url = f"http://127.0.0.1:{port}"
    data_dir = env["DATA_DIR"]
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
        write_state(runtime_dir, state="starting", host=bind_host, port=port, tunnelUrl=tunnel_url)
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

            remember_port(runtime_dir, port)
            write_access_file(data_dir, bind_host, port, tunnel_url, log)
            write_state(
                runtime_dir,
                state="ready",
                host=bind_host,
                port=port,
                book=book_id,
                tunnelUrl=tunnel_url,
                serverPid=process.pid,
            )
            print_banner(bind_host, port, tunnel_url, env)

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
        if tunnel_handle is not None:
            try:
                tunnel_handle.stop()
                log.write("tunnel closed")
            except Exception as exc:  # noqa: BLE001 - shutdown must not fail here
                log.write(f"tunnel shutdown skipped: {exc}")
        try:
            os.remove(os.path.join(data_dir, "server-access.json"))
        except OSError:
            pass
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
