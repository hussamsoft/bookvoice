#!/usr/bin/env python3
"""Smoke-test a BookVoice install directory without GPU inference."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import launch  # noqa: E402


def check_payload(app_dir: Path) -> list[str]:
    errors: list[str] = []
    message = launch.validate_package(str(app_dir))
    if message:
        errors.append(message)
    for rel in (
        "runtime/worker/python.exe",
        "runtime-manifest.json",
        "launch.py",
        "scripts/kill_stale_bookvoice.ps1",
    ):
        if not (app_dir / rel).is_file():
            errors.append(f"missing required file: {rel}")
    return errors


def wait_for_health(base_url: str, timeout_s: int = 60) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if launch.backend_is_ready(base_url):
            return True
        time.sleep(1)
    return False


def fetch_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return 200 <= response.status < 300
    except (OSError, urllib.error.URLError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test a BookVoice install directory")
    parser.add_argument(
        "--app-dir",
        type=Path,
        default=ROOT / "dist",
        help="Install directory (default: dist/)",
    )
    parser.add_argument(
        "--skip-server",
        action="store_true",
        help="Validate payload only; do not start uvicorn",
    )
    args = parser.parse_args()
    app_dir = args.app_dir.resolve()
    errors = check_payload(app_dir)
    if errors:
        for err in errors:
            print(f"[smoke] ERROR: {err}")
        return 1

    runtime_dir = launch.resolve_runtime_dir(str(app_dir))
    print(f"[smoke] app_dir={app_dir}")
    print(f"[smoke] runtime_dir={runtime_dir}")
    print(f"[smoke] install_id={launch.install_id(str(app_dir), launch.read_app_version(str(app_dir)))}")

    if args.skip_server:
        print("[smoke] payload OK")
        return 0

    os.makedirs(runtime_dir, exist_ok=True)
    log = launch.Logger(str(Path(runtime_dir) / "bookvoice_smoke.log"))
    py = launch.packaged_worker(str(app_dir), log)
    if not py:
        print("[smoke] ERROR: packaged worker runtime missing")
        return 1

    port = launch.pick_port(log)
    env = launch.build_env(str(app_dir), runtime_dir)
    proc = subprocess.Popen(
        [py, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(app_dir),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=launch._no_window(),
    )
    try:
        base = f"http://127.0.0.1:{port}"
        if not wait_for_health(base):
            print("[smoke] ERROR: /api/health did not become ready")
            return 1
        for path in ("/api/health", "/api/books", "/api/config/", "/api/voices/"):
            if not fetch_ok(base + path):
                print(f"[smoke] ERROR: {path} failed")
                return 1
        print("[smoke] server endpoints OK")
        return 0
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
