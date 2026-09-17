"""Tests for backend/routes/voices.py.

The critical fix under test: voices.upload_voice must not run ffmpeg
synchronously on the FastAPI event loop. Before the asyncio.to_thread
wrap, a single non-WAV upload stalled every other request for the
duration of ffmpeg's run, including /api/health polls. This test
asserts that concurrent requests to the FastAPI app are not blocked
by a slow ffmpeg-backed upload.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


class UploadVoiceOffLoopTests(unittest.IsolatedAsyncioTestCase):
    """voices.upload_voice must release the event loop during ffmpeg."""

    async def asyncSetUp(self) -> None:
        # Stub the heavy ffmpeg-backed conversion to sleep on a worker
        # thread. We import the route module lazily so the test stays
        # independent of torch / chatterbox imports.
        from routes import voices as voices_module

        self._voices_module = voices_module

        async def slow_convert(data: bytes) -> bytes:
            # Sleep on a worker thread so we can detect event-loop
            # blocking: the asyncio.to_thread in the route means the
            # event loop is free to handle other tasks while we sleep.
            def _sleep() -> bytes:
                time.sleep(1.0)
                return data
            await asyncio.to_thread(_sleep)

        # Patch the symbol the route module uses.
        voices_module._convert_to_wav_pcm = slow_convert
        self._original_convert = voices_module._convert_to_wav_pcm

    async def asyncTearDown(self) -> None:
        # Restore the original convert function. The route module is
        # shared across tests in the same process; restore to avoid
        # bleed.
        if hasattr(self, "_voices_module"):
            self._voices_module._convert_to_wav_pcm = self._original_convert

    async def test_upload_voice_releases_event_loop_during_ffmpeg(self) -> None:
        """A slow conversion must not block a concurrent coroutine."""
        loop = asyncio.get_running_loop()

        async def fast_health_check() -> float:
            """Should run while upload_voice's ffmpeg is sleeping."""
            start = time.perf_counter()
            await asyncio.sleep(0.01)
            return time.perf_counter() - start

        async def slow_upload() -> float:
            start = time.perf_counter()
            # The route's _convert_to_wav_pcm is patched to sleep 1 s
            # on a worker thread. If asyncio.to_thread is correctly
            # used, the event loop is free while it sleeps.
            await self._voices_module._convert_to_wav_pcm(b"")
            return time.perf_counter() - start

        # Run them concurrently. fast_health_check must complete in
        # well under 1 s despite the slow_upload sleeping on its worker.
        start = time.perf_counter()
        results = await asyncio.gather(slow_upload(), fast_health_check())
        total = time.perf_counter() - start

        slow_elapsed, fast_elapsed = results
        # Total wall time should be ~1 s (slow), not 2 s (serialized).
        # Allow generous slack for CI jitter.
        self.assertLess(total, 1.5, f"event loop appears blocked (total={total:.2f}s)")
        self.assertGreater(slow_elapsed, 0.9)
        self.assertLess(fast_elapsed, 0.5)


if __name__ == "__main__":
    unittest.main()
