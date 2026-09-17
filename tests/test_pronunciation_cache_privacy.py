"""Regression test for the pronunciation cache cross-user privacy leak
(audit finding C-26).

Before the fix, the pronunciation cache filename was a 20-char SHA
over the prompt content. The cache was served via the public
``/sessions/pronunciation-cache/<filename>.wav`` mount, so any user
who knew another user's prompt could fetch their clip. The filename
was guessable because it was a plain SHA over public-ish inputs.

After the fix, the filename includes a deployment-scoped HMAC that
requires the operator's BOOKVOICE_PRONUNCIATION_CACHE_SALT (or the
fallback derived from BOOKVOICE_SECRET_KEY / data_dir + version) to
reproduce. An attacker on the same deployment cannot reproduce the
filename without the salt.
"""
from __future__ import annotations

import importlib
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


class PronunciationCachePrivacyTests(unittest.TestCase):
    def setUp(self) -> None:
        # Reset module-level state so re-imports don't leak.
        for mod in [
            "services.tts_service.streaming",
            "services.tts_service.synth",
            "services.tts_service.model",
            "services.tts_service.queue",
            "services.config_service",
        ]:
            if mod in sys.modules:
                del sys.modules[mod]

    def _reload_streaming(self):
        """Reload the streaming module to pick up env changes."""
        import services.tts_service.streaming as streaming

        return importlib.reload(streaming)

    def _hit_cache(self, streaming):
        """Run pronounce_text with the cache 'hit' branch mocked.

        The cache-hit branch in pronounce_text is what constructs the
        audio_url with the salt-protected filename; the cache-miss
        branch delegates to _synth._synthesize_audio which we do not
        want to actually run.
        """
        import os as _os

        orig_isfile = _os.path.isfile
        orig_utime = _os.utime
        _os.path.isfile = lambda p: True  # force cache-hit branch
        _os.utime = lambda p, t: None  # don't actually touch disk
        try:
            return streaming.pronounce_text(
                text="hello world",
                session_id="reader-abc",
                voice_id=None,
                language_id="en",
            )
        finally:
            _os.path.isfile = orig_isfile
            _os.utime = orig_utime

    def test_filename_includes_mac_segment_with_salt_set(self):
        """With BOOKVOICE_PRONUNCIATION_CACHE_SALT set, filename has MAC."""
        os.environ["BOOKVOICE_PRONUNCIATION_CACHE_SALT"] = "test-salt-1"
        try:
            streaming = self._reload_streaming()
            result = self._hit_cache(streaming)
            url = result["audio_url"]
            self.assertIn("/sessions/pronunciation-cache/clip_", url)
            filename = url.rsplit("/", 1)[-1]
            stem = filename.removesuffix(".wav")
            # Format: clip_<id16>_<mac16>.wav
            self.assertTrue(stem.startswith("clip_"))
            self.assertEqual(len(stem), len("clip_") + 16 + 1 + 16)
        finally:
            os.environ.pop("BOOKVOICE_PRONUNCIATION_CACHE_SALT", None)

    def test_different_salts_yield_different_filenames(self):
        """Changing the salt invalidates the cache (different filename)."""
        os.environ["BOOKVOICE_PRONUNCIATION_CACHE_SALT"] = "salt-a"
        streaming_a = self._reload_streaming()
        url_a = self._hit_cache(streaming_a)["audio_url"]

        os.environ["BOOKVOICE_PRONUNCIATION_CACHE_SALT"] = "salt-b"
        streaming_b = self._reload_streaming()
        url_b = self._hit_cache(streaming_b)["audio_url"]

        self.assertNotEqual(url_a, url_b)

    def test_same_salt_same_prompt_same_filename(self):
        """Determinism: identical inputs under identical salt produce the
        same filename, so cache hits still work."""
        os.environ["BOOKVOICE_PRONUNCIATION_CACHE_SALT"] = "salt-x"
        try:
            streaming = self._reload_streaming()
            url1 = self._hit_cache(streaming)["audio_url"]
            url2 = self._hit_cache(streaming)["audio_url"]
            self.assertEqual(url1, url2)
        finally:
            os.environ.pop("BOOKVOICE_PRONUNCIATION_CACHE_SALT", None)

    def test_no_salt_no_secret_key_falls_back_to_data_dir_salt(self):
        """When neither salt env nor BOOKVOICE_SECRET_KEY is set, the
        function still returns a filename (the fallback is
        deterministic but deployment-specific, not user-prompt-based)."""
        os.environ.pop("BOOKVOICE_PRONUNCIATION_CACHE_SALT", None)
        os.environ.pop("BOOKVOICE_SECRET_KEY", None)
        os.environ["DATA_DIR"] = str(ROOT / "data")
        try:
            streaming = self._reload_streaming()
            url = self._hit_cache(streaming)["audio_url"]
            self.assertIn("/sessions/pronunciation-cache/clip_", url)
            filename = url.rsplit("/", 1)[-1]
            stem = filename.removesuffix(".wav")
            # Still has the MAC segment, derived from a hash of
            # (data_dir + version). An attacker who controls deployment
            # files can still predict it, but they cannot predict it
            # from the prompt alone (which was the C-26 attack surface).
            self.assertEqual(len(stem), len("clip_") + 16 + 1 + 16)
        finally:
            os.environ.pop("DATA_DIR", None)


if __name__ == "__main__":
    unittest.main()
