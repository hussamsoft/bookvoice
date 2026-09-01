#!/usr/bin/env python3
"""Smoke-test the packaged BookVoice executable payload (dist/) before MSI
packaging. Runs the packaged app the way an installed user does:

  1. Payload validation (launch.validate_package) + required files,
     including Launcher.exe.
  2. Bundle freshness: dist/static must serve the same frontend build as
     backend/static (the committed one) — catches a stale dist.
  3. Packaged-worker server boot on an isolated runtime, then API checks:
     health, config capabilities, voice seeding, book import round-trip,
     prepared-library listing, studio project scope.
  4. --launcher: also spawn Launcher.exe, wait for its backend URL from the
     server log, health-check it, and shut the process tree down cleanly.

Usage:
  python scripts/smoke_exe.py            # payload + backend + UI checks
  python scripts/smoke_exe.py --launcher # additionally test Launcher.exe
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import launch  # noqa: E402

DEVICE_HEADERS = {"X-BookVoice-Device-ID": "5" * 32}
FIXTURE_PDF = ROOT / "tests" / "fixtures" / "english.pdf"


def check_payload(app_dir: Path) -> list[str]:
    errors: list[str] = []
    message = launch.validate_package(str(app_dir))
    if message:
        errors.append(message)
    required = [
        "main.py",
        "launch.py",
        "VERSION",
        "Launcher.exe",
        "static/index.html",
        "runtime/worker/python.exe",
        "data/default_voices",
        "data/models",
    ]
    for rel in required:
        if not (app_dir / rel).exists():
            errors.append(f"missing required path: {rel}")
    if not list((app_dir / "static" / "assets").glob("index-*.js")):
        errors.append("static/assets/index-*.js missing (frontend not built into payload)")
    return errors


def asset_ref(index_html: Path) -> str | None:
    try:
        text = index_html.read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r"assets/(index-[A-Za-z0-9_-]+\.js)", text)
    return match.group(1) if match else None


def check_freshness(app_dir: Path) -> list[str]:
    """The payload must serve the same frontend build the repo commits."""
    errors: list[str] = []
    dist_ref = asset_ref(app_dir / "static" / "index.html")
    src_ref = asset_ref(ROOT / "backend" / "static" / "index.html")
    if dist_ref is None:
        errors.append("dist/static/index.html has no index-*.js asset reference")
    elif src_ref is None:
        errors.append("backend/static/index.html has no index-*.js asset reference")
    elif dist_ref != src_ref:
        errors.append(
            f"stale frontend bundle: dist serves {dist_ref}, source serves {src_ref} — "
            "rebuild with `python build.py` before packaging"
        )
    return errors


def wait_for_health(base_url: str, timeout_s: int = 120) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base_url + "/api/health", timeout=5) as response:
                if response.status == 200 and json.loads(response.read()).get("status") == "ready":
                    return True
        except Exception:
            time.sleep(1)
    return False


def request(base: str, method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = dict(DEVICE_HEADERS)
    if data is not None:
        headers["Content-Type"] = "application/json"
    call = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(call, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return exc.code, {"detail": detail}


def request_status(base: str, path: str) -> int:
    """Status code only, for routes that serve HTML/JS rather than JSON.

    `request` json-decodes every success body, so using it for the SPA index or
    a bundle asset raises JSONDecodeError before the launcher phase runs.
    """
    call = urllib.request.Request(base + path, headers=dict(DEVICE_HEADERS), method="GET")
    try:
        with urllib.request.urlopen(call, timeout=30) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as exc:
        exc.read()
        return exc.code


def upload_file(base: str, path: str, source: Path) -> tuple[int, dict]:
    boundary = f"bookvoice-smoke-{uuid.uuid4().hex}"
    body = bytearray()
    body.extend(f"--{boundary}\r\n".encode())
    body.extend(
        (
            f'Content-Disposition: form-data; name="file"; filename="{source.name}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
    )
    body.extend(source.read_bytes())
    body.extend(f"\r\n--{boundary}--\r\n".encode())
    call = urllib.request.Request(
        base + path,
        data=bytes(body),
        headers={**DEVICE_HEADERS, "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(call, timeout=60) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return exc.code, {"detail": detail}


def server_checks(base: str) -> list[str]:
    """API + functional round-trips against a running packaged backend."""
    errors: list[str] = []

    status, body = request(base, "GET", "/api/config/")
    capabilities = body.get("capabilities", {}) if isinstance(body, dict) else {}
    if status != 200 or "localFileActions" not in capabilities:
        errors.append(f"/api/config/ missing capabilities: {status} {body}")

    status, body = request(base, "GET", "/api/voices/")
    voices = body.get("voices", []) if isinstance(body, dict) else body
    if status != 200 or not isinstance(voices, list) or not voices:
        errors.append(f"/api/voices/ did not report seeded voices: {status} {body}")

    status, body = request(base, "GET", "/api/books")
    if status != 200 or not isinstance(body.get("books"), list):
        errors.append(f"/api/books failed: {status} {body}")

    if not FIXTURE_PDF.is_file():
        errors.append(f"fixture missing: {FIXTURE_PDF}")
    else:
        # POST /api/books and GET /api/books/{id} return the book unwrapped
        # (only the list route wraps, as {"books": [...]}); frontend api.js
        # consumes both the same way.
        status, body = upload_file(base, "/api/books", FIXTURE_PDF)
        book_id = body.get("id") if isinstance(body, dict) else None
        if status != 201 or not book_id:
            errors.append(f"book import failed: {status} {body}")
        else:
            status, body = request(base, "GET", f"/api/books/{book_id}")
            if status != 200 or body.get("id") != book_id:
                errors.append(f"imported book detail failed: {status} {body}")

    status, body = request(base, "GET", "/api/studio/projects")
    if status != 200 or not isinstance(body, dict):
        errors.append(f"/api/studio/projects failed: {status} {body}")

    status = request_status(base, "/")
    if status != 200:
        errors.append(f"static index not served: {status}")
    else:
        index_ref = asset_ref(ROOT / "dist" / "static" / "index.html")
        if index_ref:
            status = request_status(base, f"/assets/{index_ref}")
            if status != 200:
                errors.append(f"bundle asset not served: /assets/{index_ref} -> {status}")

    return errors


def find_url_in_log(log_text: str) -> str | None:
    match = re.search(r"http://127\.0\.0\.1:(\d+)", log_text)
    return f"http://127.0.0.1:{match.group(1)}" if match else None


def test_launcher(app_dir: Path, runtime_dir: Path) -> list[str]:
    """Spawn the real Launcher.exe and verify it brings the backend up."""
    errors: list[str] = []
    env = launch.build_env(str(app_dir), str(runtime_dir))
    env["BOOKVOICE_PORTABLE"] = "1"
    exe = app_dir / "Launcher.exe"
    proc = subprocess.Popen([str(exe)], cwd=str(app_dir), env=env)
    url = None
    deadline = time.time() + 180
    server_log = Path(runtime_dir) / "bookvoice_server.log"
    while time.time() < deadline and url is None:
        if server_log.is_file():
            url = find_url_in_log(server_log.read_text(encoding="utf-8", errors="replace"))
        if url is None:
            time.sleep(2)
    if url is None:
        errors.append("Launcher.exe started but no backend URL appeared in its server log")
    elif not wait_for_health(url, timeout_s=90):
        errors.append(f"Launcher.exe backend never became healthy at {url}")
    else:
        status, body = request(url, "GET", "/api/config/")
        if status != 200:
            errors.append(f"Launcher.exe /api/config/ failed: {status} {body}")
        else:
            print(f"[ok]   Launcher.exe backend healthy at {url}")
    if proc.poll() is None:
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True,
        )
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test the packaged dist/ payload before MSI packaging")
    parser.add_argument("--app-dir", type=Path, default=ROOT / "dist", help="packaged payload directory (default: dist/)")
    parser.add_argument("--launcher", action="store_true", help="also spawn and verify Launcher.exe")
    args = parser.parse_args()
    app_dir = args.app_dir.resolve()
    failures = 0

    print(f"[smoke] app_dir={app_dir}")
    errors = check_payload(app_dir)
    errors += check_freshness(app_dir)
    if errors:
        for err in errors:
            print(f"[fail] {err}")
        return 1
    print("[ok]   payload + bundle freshness")

    with tempfile.TemporaryDirectory(prefix="bookvoice-exe-smoke-") as smoke_runtime:
        print(f"[smoke] isolated_runtime={smoke_runtime}")
        log = launch.Logger(str(Path(smoke_runtime) / "bookvoice_smoke.log"))
        py = launch.packaged_worker(str(app_dir), log)
        if not py:
            print("[fail] packaged worker runtime missing")
            return 1
        port = launch.pick_port(log)
        env = launch.build_env(str(app_dir), smoke_runtime)
        server_log_path = Path(smoke_runtime) / "bookvoice_server.log"
        with server_log_path.open("wb") as server_log:
            proc = subprocess.Popen(
                [py, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port)],
                cwd=str(app_dir),
                env=env,
                stdout=server_log,
                stderr=subprocess.STDOUT,
                creationflags=launch._no_window(),
            )
            try:
                base = f"http://127.0.0.1:{port}"
                if not wait_for_health(base):
                    print("[fail] /api/health never became ready")
                    print(server_log_path.read_text(encoding="utf-8", errors="replace")[-2500:])
                    failures += 1
                else:
                    print("[ok]   packaged backend healthy")
                    for err in server_checks(base):
                        print(f"[fail] {err}")
                        failures += 1
                    if not failures:
                        print("[ok]   API + functional round-trips")
                if args.launcher:
                    print("[smoke] launching Launcher.exe (a window may appear briefly)…")
                    for err in test_launcher(app_dir, smoke_runtime):
                        print(f"[fail] {err}")
                        failures += 1
            finally:
                if proc.poll() is None:
                    subprocess.run(
                        ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                        capture_output=True,
                    )

    if failures:
        print(f"[smoke] FAILED ({failures} issue(s))")
        return 1
    print("[smoke] PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
