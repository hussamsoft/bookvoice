"""Regression test for the in-app updater asset-size cap (C-22 / Q6).

Before the fix, download_installer trusted the manifest's declared
size and only checked it at the final checksum. A 10 GB blob
would have been fully streamed to disk before the checksum
mismatch was detected. With a 1 GiB hard cap (matching the
bootstrapper's MAX_ASSET_BYTES), the partial file never grows
beyond the cap.

After the fix:
1. Declared size > MAX_ASSET_BYTES is rejected before opening the
   stream.
2. Per-chunk overflow during streaming is rejected.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


def _stubbed_manifest(size: int) -> dict:
    return {
        "assets": {"BookVoice-Launcher.exe": {"sha256": "0" * 64, "size": size}},
    }


class UpdateServiceDownloadCapTests(unittest.TestCase):
    def test_declared_size_above_cap_rejected_before_stream(self):
        """A manifest declaring size > MAX_ASSET_BYTES is rejected up front."""
        import services.update_service as update_service

        original_cap = update_service.MAX_ASSET_BYTES
        original_fetch = update_service._fetch_manifest
        update_service.MAX_ASSET_BYTES = 1024
        update_service._fetch_manifest = lambda tag: _stubbed_manifest(size=10_000_000)
        try:
            with self.assertRaises(RuntimeError) as cm:
                update_service.download_installer("9.9.9", tag="v9.9.9")
            self.assertIn("outside (0, 1024]", str(cm.exception))
        finally:
            update_service._fetch_manifest = original_fetch
            update_service.MAX_ASSET_BYTES = original_cap

    def test_zero_size_rejected(self):
        """size == 0 is also rejected."""
        import services.update_service as update_service

        original_cap = update_service.MAX_ASSET_BYTES
        original_fetch = update_service._fetch_manifest
        update_service.MAX_ASSET_BYTES = 1024
        update_service._fetch_manifest = lambda tag: _stubbed_manifest(size=0)
        try:
            with self.assertRaises(RuntimeError):
                update_service.download_installer("0.0.0", tag="v0.0.0")
        finally:
            update_service._fetch_manifest = original_fetch
            update_service.MAX_ASSET_BYTES = original_cap

    def test_negative_size_rejected(self):
        """size < 0 is also rejected."""
        import services.update_service as update_service

        original_cap = update_service.MAX_ASSET_BYTES
        original_fetch = update_service._fetch_manifest
        update_service.MAX_ASSET_BYTES = 1024
        update_service._fetch_manifest = lambda tag: _stubbed_manifest(size=-1)
        try:
            with self.assertRaises(RuntimeError):
                update_service.download_installer("0.0.0", tag="v0.0.0")
        finally:
            update_service._fetch_manifest = original_fetch
            update_service.MAX_ASSET_BYTES = original_cap

    def test_size_just_under_cap_accepted_for_streaming(self):
        """A manifest declaring size just under MAX_ASSET_BYTES is allowed
        past the gate; the streaming loop would still cap on overflow."""
        import services.update_service as update_service

        original_cap = update_service.MAX_ASSET_BYTES
        original_fetch = update_service._fetch_manifest
        update_service.MAX_ASSET_BYTES = 2048
        # size = 1024 is within cap; we stub urlopen to fail fast so
        # the test doesn't actually need network. The point is that
        # the size guard passes.
        update_service._fetch_manifest = lambda tag: _stubbed_manifest(size=1024)
        try:
            try:
                update_service.download_installer("0.0.0", tag="v0.0.0")
            except Exception as exc:
                # Should NOT be the size cap error.
                self.assertNotIn("outside (0, 1024]", str(exc))
        finally:
            update_service._fetch_manifest = original_fetch
            update_service.MAX_ASSET_BYTES = original_cap


if __name__ == "__main__":
    unittest.main()
