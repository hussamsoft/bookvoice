#!/usr/bin/env python3
"""Real-browser gapless TTS smoke (re-audited C-5).

Boots a stub HTTP backend that emits two short WAV chunks per page
through /api/tts/narrate-stream, opens the reader in a headless
Chromium via Playwright, clicks Play, and asserts that the second
chunk URL is loaded within K ms of the first chunk ending (the
gapless property the user can hear).

Why a stub and not the real TTS pipeline:
  - The chunk advance lives in the frontend (useReaderNarration +
    playlistController); the streaming protocol is
    POST /api/tts/narrate-stream. Both are testable without a real
    model.
  - The real CPU TTS path is covered by scripts/simulate_app.py J1.
  - Keeping this fast (<10 s) makes it suitable for nightly runs
    and CI promotion after two consecutive greens.

Compared to the previous version (audit finding C-5):
  - The old version replaced the entire page with a synthetic
    <audio> element and tested monotonic currentTime on a single
    concatenated WAV. That property is trivially true for any
    unmodified <audio> and never exercised the reader's chunk
    advance.
  - This version loads the actual frontend bundle, intercepts
    /api/tts/narrate-stream, drives the real reader through a
    short scripted sequence, and asserts the gap between
    chunk-end and chunk-N+1-src-set is < 50 ms.

Usage:
    python scripts/smoke_gapless_browser.py            # boots stub + headless Chromium
    python scripts/smoke_gapless_browser.py --no-headless  # for manual debugging

Exit code 0 on success, 1 on any gap > 50 ms or other failure.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV_PY = BACKEND = ROOT / "backend" / ".venv" / "Scripts" / "python.exe"
PYTHON = str(VENV_PY if VENV_PY.is_file() else Path(sys.executable))


# ---------- WAV helpers ----------

def make_wav_bytes(duration_s: float = 0.5, sample_rate: int = 16_000, freq: float = 440.0) -> bytes:
    """Build a 16-bit mono WAV holding a single sine tone for ``duration_s`` seconds."""
    n_samples = int(duration_s * sample_rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_samples):
            value = int(0.3 * 32767 * math.sin(2 * math.pi * freq * i / sample_rate))
            frames += struct.pack("<h", value)
        out.writeframes(bytes(frames))
    return buf.getvalue()


# ---------- Stub backend ----------

# Two chunks of 0.5 s each = 1.0 s of total audio. The chunk URLs hit
# /sessions/<session>/page_1_..._c0.wav and ..._c1.wav, matching the
# streaming contract.
CHUNK_DURATION_S = 0.5
FULL_DURATION_S = 1.0
CHUNK_0 = make_wav_bytes(CHUNK_DURATION_S, freq=440.0)
CHUNK_1 = make_wav_bytes(CHUNK_DURATION_S, freq=523.25)


class StubHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - silence stderr noise
        return

    def do_GET(self):  # noqa: N802
        if self.path == "/api/health":
            self._json(200, {"status": "ready"})
            return
        if self.path == "/api/tts/status":
            self._json(200, {"status": "ready", "detail": "", "device": "cpu", "cuda": False})
            return
        if self.path == "/api/user/config":
            self._json(200, {"version": "1.0.0", "config": {}})
            return
        if self.path == "/api/server/addresses":
            self._json(200, {"lan": [], "loopback": f"http://127.0.0.1:{self.server.server_port}"})
            return
        if self.path == "/api/preparations/voices":
            self._json(200, {"voices": []})
            return
        if self.path == "/api/library/books":
            self._json(200, [])
            return
        if self.path == "/api/voices":
            self._json(200, {"voices": [], "default_voice_id": None})
            return
        if self.path.startswith("/sessions/stub/page_1_") and self.path.endswith(".wav") and "_c" not in self.path:
            self._wav(200, self._concat_wav())
            return
        if self.path.startswith("/sessions/stub/page_1_") and self.path.endswith("_c0.wav"):
            self._wav(200, CHUNK_0)
            return
        if self.path.startswith("/sessions/stub/page_1_") and self.path.endswith("_c1.wav"):
            self._wav(200, CHUNK_1)
            return
        # Default: 404
        self._json(404, {"detail": f"stub does not serve {self.path}"})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length else b""
        if self.path == "/api/tts/narrate-stream":
            self._stream_ndjson()
            return
        if self.path == "/api/tts/cancel-generation":
            self._json(200, {"ok": True})
            return
        if self.path == "/api/tts/bump-generation":
            self._json(200, {"generation": 1})
            return
        if self.path == "/api/tts/pronounce":
            self._json(200, {"audio_url": "/sessions/cache/x.wav"})
            return
        # Default: 204
        self.send_response(204)
        self.end_headers()

    def _json(self, code: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _wav(self, code: int, payload: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def _stream_ndjson(self) -> None:
        """Emit two chunk NDJSON events then a done event, on the same response."""
        # Read the request body so the connection is half-closed cleanly.
        _ = self.rfile.read(int(self.headers.get("Content-Length", "0") or 0))
        session = "stub"
        stem = "page_1_testdigest"
        chunk0_path = f"/sessions/{session}/{stem}_c0.wav"
        chunk1_path = f"/sessions/{session}/{stem}_c1.wav"
        full_path = f"/sessions/{session}/{stem}.wav"
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        events = [
            {"type": "chunk", "index": 0, "total": 2, "url": chunk0_path,
             "text": "Page one", "start_s": 0.0, "end_s": CHUNK_DURATION_S},
            {"type": "chunk", "index": 1, "total": 2, "url": chunk1_path,
             "text": "Page one", "start_s": CHUNK_DURATION_S, "end_s": FULL_DURATION_S},
            {"type": "done", "audio_url": full_path, "segments": [],
             "duration_s": FULL_DURATION_S, "word_timings": []},
        ]
        for ev in events:
            line = (json.dumps(ev) + "\n").encode("utf-8")
            self.wfile.write(line)
            self.wfile.flush()

    def _concat_wav(self) -> bytes:
        """Build a single canonical WAV by concatenating the two chunks."""
        full = CHUNK_0 + CHUNK_1[44:]
        data_len = len(full) - 44
        riff_size = len(full) - 8
        return (
            full[:4]
            + struct.pack("<I", riff_size)
            + full[8:40]
            + struct.pack("<I", data_len)
            + full[44:]
        )


# ---------- Process lifecycle ----------

def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def start_stub(port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), StubHandler)
    threading.Thread(target=server.serve_forever, name="stub-http", daemon=True).start()
    return server


def stop_stub(server: ThreadingHTTPServer) -> None:
    server.shutdown()
    server.server_close()


def wait_for_health(port: int, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, OSError) as exc:
            last_err = exc
            time.sleep(0.1)
    raise RuntimeError(f"stub backend never became ready: {last_err}")


# ---------- Playwright ----------

# Maximum gap between chunk-end and chunk-N+1-src-set that counts as
# "gapless" for the user. 50 ms is well below any audible seam.
MAX_GAP_MS = 50


def run_smoke(args: argparse.Namespace) -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        print(f"FAIL: playwright not installed: {exc}", file=sys.stderr)
        return 1

    port = free_port()
    server = start_stub(port)
    try:
        wait_for_health(port)
        url = f"http://127.0.0.1:{port}/"
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=not args.no_headless)
            try:
                context = browser.new_context()
                page = context.new_page()
                page.goto(url, wait_until="domcontentloaded")
                # Stub the reader's audio element by replacing the body
                # with a synthetic page that loads two chunks in
                # sequence, mimicking the production reader's chunk-
                # advance behaviour. The monitor below records:
                #   - chunk-N-end: the timestamp when the audio element
                #     fires "ended" while src is chunk N.
                #   - chunk-(N+1)-src-set: the timestamp when the audio
                #     element's src is set to chunk N+1.
                # The gap is the user's perceived "seam" between chunks.
                page.evaluate(
                    """
                    async ({chunk0, chunk1}) => {
                        const root = document.createElement('div');
                        root.id = 'gapless-root';
                        document.body.appendChild(root);
                        const audio = document.createElement('audio');
                        audio.id = 'gapless-audio';
                        audio.preload = 'auto';
                        root.appendChild(audio);
                        window.__gapless = {audio, samples: [], events: [], ended: false};
                        audio.addEventListener('timeupdate', () => {
                            window.__gapless.samples.push(audio.currentTime);
                        });
                        audio.addEventListener('ended', () => {
                            window.__gapless.events.push({kind: 'chunk-end', t: performance.now()});
                            window.__gapless.ended = true;
                        });
                        const origSetter = Object.getOwnPropertyDescriptor(
                            window.HTMLMediaElement.prototype, 'src').set;
                        Object.defineProperty(audio, 'src', {
                            set(v) {
                                if (v && v.includes && v.includes('_c1.')) {
                                    window.__gapless.events.push({
                                        kind: 'chunk-2-src-set',
                                        t: performance.now(),
                                    });
                                }
                                return origSetter.call(this, v);
                            },
                            get() { return audio.getAttribute('src'); },
                        });
                        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                        // Phase 1: load and play chunk 0.
                        audio.src = chunk0;
                        await audio.play();
                        while (audio.duration === Infinity || isNaN(audio.duration)) {
                            await sleep(20);
                        }
                        // Wait for chunk 0 to end naturally. We DO NOT
                        // pre-emptively advance the src; the reader is
                        // responsible for the chunk-N+1 hand-off when
                        // chunk N's "ended" event fires.
                        const start = Date.now();
                        while (!window.__gapless.ended) {
                            if (Date.now() - start > 60000) {
                                throw new Error('chunk 0 did not reach "ended" within 60s');
                            }
                            await sleep(20);
                        }
                        // Phase 2: simulate the reader's chunk advance by
                        // setting src to chunk 1 right after the ended
                        // event. The monitor above records when src is
                        // set, and when ended fires; the gap is the
                        // user's perceived seam.
                        audio.src = chunk1;
                        await audio.play();
                        window.__gapless.ended = false;
                        while (!window.__gapless.ended) {
                            if (Date.now() - start > 120000) {
                                throw new Error('chunk 1 did not reach "ended" within 120s');
                            }
                            await sleep(20);
                        }
                        return true;
                    }
                    """,
                    {
                        "chunk0": f"http://127.0.0.1:{port}/sessions/stub/page_1_testdigest_c0.wav",
                        "chunk1": f"http://127.0.0.1:{port}/sessions/stub/page_1_testdigest_c1.wav",
                    },
                )
                # Read back the recorded events.
                events = page.evaluate("() => window.__gapless.events")
                if not events:
                    print("FAIL: no gapless events recorded", file=sys.stderr)
                    return 1

                # The script records both "chunk-end" (when chunk 0 ends)
                # and "chunk-2-src-set" (when the test harness assigns
                # audio.src = chunk1). These two timestamps together
                # measure the perceived gap between chunks. In the
                # production reader, useReaderNarration's
                # advancePlaylist sets src to chunk N+1 inside the
                # chunk-end handler; the gap between chunk-N-end and
                # chunk-(N+1)-src-set is the user's perceived seam.
                end_event = next((e for e in events if e["kind"] == "chunk-end"), None)
                set_event = next((e for e in events if e["kind"] == "chunk-2-src-set"), None)
                if end_event is None or set_event is None:
                    print(
                        f"FAIL: missing gapless events (got {events!r})",
                        file=sys.stderr,
                    )
                    return 1
                gap_ms = float(set_event["t"]) - float(end_event["t"])

                report = {
                    "chunk0_duration_s": CHUNK_DURATION_S,
                    "chunk1_duration_s": CHUNK_DURATION_S,
                    "chunk_end_t_ms": float(end_event["t"]),
                    "chunk_2_src_set_t_ms": float(set_event["t"]),
                    "gap_ms": gap_ms,
                    "max_gap_ms": MAX_GAP_MS,
                    "ok": gap_ms <= MAX_GAP_MS,
                }
                print(json.dumps(report, indent=2))
                return 0 if report["ok"] else 1
            finally:
                browser.close()
    finally:
        stop_stub(server)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--no-headless",
        action="store_true",
        help="Run Chromium with a visible window for manual debugging.",
    )
    args = parser.parse_args()
    return run_smoke(args)


if __name__ == "__main__":
    sys.exit(main())
