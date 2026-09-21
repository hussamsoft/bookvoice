"""F-43 (non-logging part) — backend startup hygiene guards.

`backend/main.py` cannot be imported in tests without executing its
module side effects (torch CUDA context init, TTS worker thread, env-dir
creation), so these are source-contract tests rather than functional ones:
they pin the three startup decisions the finding demanded so a regression
is loud, and each mirrors a concrete failure mode.
"""

from __future__ import annotations

import unittest
from pathlib import Path

MAIN_PY = Path(__file__).resolve().parents[1] / "backend" / "main.py"
SOURCE = MAIN_PY.read_text(encoding="utf8")


class MainStartupHygieneTests(unittest.TestCase):
    def test_static_dir_is_anchored_to_app_dir_not_cwd(self):
        # CWD-relative `Path("static").resolve()` silently degraded to the
        # "Frontend not built" JSON root when the launcher's cwd differed.
        self.assertIn('(Path(APP_DIR) / "static").resolve()', SOURCE)
        self.assertNotIn('Path("static").resolve()', SOURCE)

    def test_voice_seed_runs_in_lifespan_not_at_import_time(self):
        # The seed used to run at module import, swallowing errors to a
        # print; every other startup side effect lives in `lifespan`.
        lifespan_at = SOURCE.find("async def lifespan")
        seed_at = SOURCE.find("voices.seed_default_voices()")
        self.assertGreater(lifespan_at, -1, "lifespan() missing")
        self.assertGreater(seed_at, -1, "voice seeding vanished entirely")
        self.assertGreater(
            seed_at, lifespan_at,
            "voices.seed_default_voices() must be called inside lifespan(), not before it",
        )

    def test_style_src_unsafe_inline_is_documented(self):
        # A reader must not "harden" style-src to 'self' and break the
        # reader's inline styles; the rationale has to sit next to the header.
        header_at = SOURCE.find("style-src 'self' 'unsafe-inline'")
        self.assertGreater(header_at, -1)
        preamble = SOURCE[max(0, header_at - 700):header_at]
        self.assertIn("unsafe-inline", preamble.lower().replace("'", ""), "missing deliberate-inline-styles comment")
        self.assertTrue(
            "deliberate" in preamble.lower() or "unavoidable" in preamble.lower(),
            "the comment above style-src must say the choice is deliberate",
        )


if __name__ == "__main__":
    unittest.main()
