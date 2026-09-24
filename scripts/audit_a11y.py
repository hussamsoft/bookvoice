#!/usr/bin/env python3
"""Accessibility audit over the five primary routes.

Boots the real frontend dev server against the stub backend, opens
each route in headless Chromium, injects axe-core, and reports WCAG
violations. The report is split per route; issues that cannot be auto-
fixed are filed as numbered follow-ups in ``tasks/todo.md`` by the
script's caller.

Routes scanned:
  /           Home
  /library    Library
  /reader     Reader (the new ``Reader`` is default per Phase 0.2)
  /studio     Voice Studio
  /settings   Settings

Each route is scanned in light and dark mode, and once with a keyboard-
only traversal that records the focused element at each ``Tab`` press.

Usage:
  python scripts/audit_a11y.py
  python scripts/audit_a11y.py --no-headless
  python scripts/audit_a11y.py --json report.json   # write a JSON report
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"


# ---------- Stub backend ----------

class StubHandler(BaseHTTPRequestHandler):
    """Bare-minimum stub: every API returns 200 with a sensible empty body."""

    def log_message(self, format, *args):  # noqa: A002
        return

    def _json(self, code: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):  # noqa: N802
        # Phase 4: match on the query-less, trailing-slash-free path. The
        # client fetches /api/voices/ (FastAPI redirects the slash-less
        # form), and an exact string match sent it to the catch-all `{}`
        # — which made VoiceSettings crash the whole Settings route behind
        # the ErrorBoundary during the audit.
        path = self.path.split("?", 1)[0].rstrip("/")
        if path == "/api/health":
            self._json(200, {"status": "ready"})
        elif path == "/api/tts/status":
            self._json(200, {"status": "ready", "detail": "", "device": "cpu", "cuda": False})
        elif path == "/api/user/config":
            self._json(200, {"version": "1.0.0", "config": {}})
        elif path == "/api/server/addresses":
            self._json(200, {"lan": [], "loopback": "http://127.0.0.1:1"})
        elif path == "/api/library/books":
            self._json(200, [])
        elif path == "/api/voices":
            self._json(200, {"voices": [], "default_voice_id": None})
        elif path == "/api/studio/projects":
            self._json(200, [])
        elif path == "/api/preparations/voices":
            self._json(200, {"voices": []})
        else:
            self._json(200, {})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0") or 0)
        _ = self.rfile.read(length) if length else b""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()


# ---------- Combined handler (audit finding C-26 fix) ----------

# Earlier revisions of this script booted TWO HTTP servers on
# different loopback ports — one for /api/* (StubHandler) and one for
# the SPA assets (StaticHandler). The frontend's index.html calls
# /api/* relative to its own origin, so all API requests in the audit
# landed on the static server and returned 404. Every WCAG scan was
# therefore taken against a frontend whose API was non-functional and
# any axe-core finding that depended on real backend data (Library,
# Studio) was missed.

# The combined handler below serves /api/* from the stub and routes
# everything else through the production SPA fallback, on ONE port.
# This matches the production shape: backend and frontend share an
# origin in BookVoice.

STATIC_ROOT = ROOT / "backend" / "static"


class CombinedHandler(StubHandler):
    """One handler, one port: /api/* is the stub; everything else is the SPA."""

    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        # API stub: everything under /api/.
        if path.startswith("/api/"):
            return StubHandler.do_GET(self)
        # SPA static assets + fallback for non-asset routes.
        if path == "/" or not path.startswith("/"):
            path = "/index.html"
        full = (STATIC_ROOT / path.lstrip("/")).resolve()
        try:
            full.relative_to(STATIC_ROOT.resolve())
        except ValueError:
            self.send_response(403)
            self.end_headers()
            return
        if full.is_file():
            self._serve(full)
            return
        index = STATIC_ROOT / "index.html"
        if index.is_file():
            self._serve(index, target_path=path)
            return
        self.send_response(404)
        self.end_headers()

    def _serve(self, full: Path, target_path: str = "") -> None:
        import mimetypes
        mime, _ = mimetypes.guess_type(str(full))
        body = full.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def start_combined_server(port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), CombinedHandler)
    threading.Thread(target=server.serve_forever, name="a11y-combined", daemon=True).start()
    return server


def stop_combined_server(server: ThreadingHTTPServer) -> None:
    server.shutdown()
    server.server_close()


def wait_for_http(url: str, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    last: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                if resp.status < 500:
                    return
        except urllib.error.HTTPError as exc:
            last = exc
            time.sleep(0.2)
        except (urllib.error.URLError, ConnectionError, OSError) as exc:
            last = exc
            time.sleep(0.2)
    raise RuntimeError(f"timed out waiting for {url}: {last}")


# ---------- axe-core via vendored bundle ----------

# Vendoring axe-core avoids the silent-green failure mode where a CDN
# tamper, downgrade, or outage quietly makes the audit pass. The
# vendored copy at ``scripts/vendor/axe.min.js`` is pinned by SHA256 and
# verified on every audit run; a mismatch or missing file is treated as
# a hard error so the CI gate cannot be bypassed by editing the network.
sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))
import axe as _axe_vendor  # noqa: E402  - import after sys.path tweak


def _load_vendored_axe() -> bytes:
    """Load the vendored axe-core bundle, verifying its SHA256.

    The SHA256 is pinned in ``scripts/vendor/axe.py``; if it ever drifts
    we raise rather than fall back to the CDN. This prevents a CDN
    compromise (or accidental downgrade) from silently turning the audit
    green.
    """
    path = _axe_vendor.expected_path()
    if not path.exists():
        raise RuntimeError(
            f"Vendored axe-core is missing at {path}. "
            "Run `python scripts/vendor/fetch.py axe-core` to fetch it."
        )
    payload = path.read_bytes()
    digest = _axe_vendor.verify_axe(payload)
    return payload


def _build_inject_script(payload: bytes) -> str:
    """Wrap the verified axe-core bytes in a JS expression Playwright can run.

    Using ``new Function`` to evaluate the bytes directly avoids loading
    from any network origin. ``JSON.stringify`` escapes the JS safely.
    """
    encoded = json.dumps(payload.decode("utf-8", errors="replace"))
    return (
        "async () => {\n"
        "  if (window.axe) return;\n"
        f"  const src = {encoded};\n"
        "  const script = document.createElement('script');\n"
        "  script.text = src;\n"
        "  document.head.appendChild(script);\n"
        "  if (!window.axe) throw new Error('axe-core did not initialise after injection.');\n"
        "}\n"
    )


# ---------- Audit ----------

ROUTES = ["/", "/library", "/reader", "/studio", "/settings"]

# Phase 4: App.jsx derives the visible view from localStorage
# ('bookvoice.app.view') or a ?book= deep link — never from the URL path.
# Goto'ing /settings therefore rendered the HOME view and every route was
# scanned twice as the same surface. Map each route to the state that
# actually mounts it. ('reader' is not a storable view — it is reached via
# ?book=; the stub library does not know the id, so the Reader scans in its
# open-a-book empty state.)
VIEW_FOR_ROUTE = {
    "/": "home",
    "/library": "library",
    "/reader": "home",
    "/studio": "studio",
    "/settings": "settings",
}
URL_FOR_ROUTE = {
    "/": "/",
    "/library": "/library",
    "/reader": "/?book=audit-1",
    "/studio": "/studio",
    "/settings": "/settings",
}
MODES = ["light", "dark"]


def audit_route(page, route: str, mode: str) -> dict:
    """Inject axe-core, run a full-page audit, return the violations list."""
    payload = _load_vendored_axe()
    page.evaluate(_build_inject_script(payload))
    page.evaluate(f"() => {{ document.documentElement.dataset.mode = '{mode}'; }}")
    # Color and surface transitions are part of the redesign. Axe must inspect
    # the settled mode, not a frame halfway between Paper and Night.
    page.evaluate(
        "() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})))"
    )
    # Wait for axe to be defined; the inline injection above awaits it.
    has_axe = page.evaluate("() => typeof window.axe === 'object'")
    if not has_axe:
        raise RuntimeError(
            "axe-core failed to initialise after vendored injection; "
            "audit cannot continue with a partial result."
        )
    result = page.evaluate(
        """
        async () => {
            const r = await window.axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
            });
            return JSON.stringify(r.violations);
        }
        """
    )
    violations = json.loads(result)
    return {
        "route": route,
        "mode": mode,
        "violations": _shape_violations(violations),
    }


def _shape_violations(raw: list) -> list[dict]:
    out = []
    for v in raw:
        all_nodes = v.get("nodes", []) or []
        nodes = [
            {
                "target": n.get("target", []),
                "html": (n.get("html") or "")[:200],
                "failureSummary": n.get("failureSummary") or "",
            }
            for n in all_nodes
        ]
        out.append(
            {
                "id": v.get("id"),
                "ruleId": v.get("id"),
                "impact": v.get("impact"),
                "help": v.get("help"),
                "helpUrl": v.get("helpUrl"),
                "description": v.get("description"),
                "nodeCount": len(nodes),
                "nodes": nodes,
            }
        )
    return out


def keyboard_traversal(page, route: str, frontend_port: int) -> list[dict]:
    """Tab through the page once and record each focused element's selector and accessible name."""
    page.goto(
        f"http://127.0.0.1:{frontend_port}{URL_FOR_ROUTE[route]}",
        wait_until="networkidle",
    )
    focused: list[dict] = []
    seen_keys: set[tuple] = set()
    cap = 100
    for _ in range(cap):
        # Phase 4: press Tab BEFORE recording. The original order evaluated
        # activeElement first — which is <body> on a fresh load — and broke
        # out immediately, so every traversal silently recorded zero stops.
        page.keyboard.press("Tab")
        info = page.evaluate(
            """
            () => {
                const el = document.activeElement;
                if (!el || el === document.body) return null;
                return {
                    tag: el.tagName.toLowerCase(),
                    id: el.id || null,
                    name: el.getAttribute('aria-label') || el.textContent?.trim()?.slice(0, 80) || null,
                    role: el.getAttribute('role') || null,
                };
            }
            """
        )
        if info is None:
            break
        key = (info.get("tag"), info.get("id"), info.get("name"))
        if key in seen_keys:
            break
        seen_keys.add(key)
        focused.append(info)
    return focused


def run_audit(args: argparse.Namespace) -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        print(f"FAIL: playwright not installed: {exc}", file=sys.stderr)
        return 1

    # One port serves both the stub /api/* and the SPA. The combined
    # handler (CombinedHandler above) routes accordingly; this is the
    # audit-finding-C-26 fix: previously the API stub and the static
    # server were on different ports and the SPA's relative /api/*
    # calls landed on the static server.
    port = free_port()
    server = start_combined_server(port)
    try:
        wait_for_http(f"http://127.0.0.1:{port}/", timeout=10.0)
        report: dict = {"routes": [], "keyboardTraversals": {}}
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=not args.no_headless)
            try:
                context = browser.new_context()
                page = context.new_page()
                for route in ROUTES:
                    url = f"http://127.0.0.1:{port}{URL_FOR_ROUTE[route]}"
                    page.goto(url, wait_until="domcontentloaded")
                    # The app reads its view from localStorage, not the path:
                    # set it, then load the URL that mounts the surface.
                    page.evaluate(
                        "(v) => localStorage.setItem('bookvoice.app.view', v)",
                        VIEW_FOR_ROUTE[route],
                    )
                    page.goto(url, wait_until="networkidle")
                    for mode in MODES:
                        result = audit_route(page, route, mode)
                        report["routes"].append(result)
                    try:
                        report["keyboardTraversals"][route] = keyboard_traversal(
                            page, route, port
                        )
                    except Exception as exc:
                        report["keyboardTraversals"][route] = {"error": str(exc)}
            finally:
                browser.close()
    finally:
        stop_combined_server(server)

    _emit_report(report, args)
    return 0


def _emit_report(report: dict, args: argparse.Namespace) -> None:
    summary = {
        "routesScanned": len(report["routes"]),
        "violationsByRoute": {
            entry["route"]: sum(v.get("nodeCount", 0) for v in entry.get("violations", []))
            for entry in report["routes"]
        },
    }
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"summary": summary, "report": report}, f, indent=2)
        print(f"wrote {args.json}")
    print(json.dumps(summary, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-headless", action="store_true")
    parser.add_argument("--json", help="Write the full report to this JSON file.")
    args = parser.parse_args()
    return run_audit(args)


if __name__ == "__main__":
    sys.exit(main())
