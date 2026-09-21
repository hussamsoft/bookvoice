"""F-03 — theme bootstrap must not be an inline script.

`backend/main.py` serves every page with `Content-Security-Policy` whose
`script-src` falls back to `default-src 'self'`. An inline `<script>` in
`frontend/index.html` violates that policy and is blocked in production,
so the pre-paint theme bootstrap never runs. Dark-mode users see a white
flash on every cold start.

The fix is to move the bootstrap into `frontend/public/theme-boot.js` and
load it as `<script src="/theme-boot.js">`, which `'self'` allows without
needing `'unsafe-inline'` or a per-build SHA hash.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML = ROOT / "frontend" / "index.html"
THEME_BOOT = ROOT / "frontend" / "public" / "theme-boot.js"
STATIC_INDEX = ROOT / "backend" / "static" / "index.html"
STATIC_BOOT = ROOT / "backend" / "static" / "theme-boot.js"


class ThemeBootstrapExternalizedTests(unittest.TestCase):
    def test_index_html_has_no_inline_script_block(self):
        text = INDEX_HTML.read_text(encoding="utf8")
        # The only `<script>` we ship at the top level is the Vite module
        # entry at the bottom of <body> (which has `type="module"` and a
        # `src=`, so it isn't an inline script under CSP). Everything else
        # must come from an external file.
        for match in re.finditer(r"<script\b[^>]*>", text, flags=re.IGNORECASE):
            tag = match.group(0)
            self.assertIn(
                'src=',
                tag,
                f"inline <script> in frontend/index.html would be blocked "
                f"by the production CSP — move it to a file: {tag!r}",
            )

    def test_index_html_loads_theme_boot_as_external_script(self):
        text = INDEX_HTML.read_text(encoding="utf8")
        self.assertRegex(
            text,
            r'<script\s+src="[^"]*theme-boot\.js"',
            "frontend/index.html must reference /theme-boot.js as an "
            "external <script src=...>",
        )

    def test_theme_boot_file_exists_and_is_minimal(self):
        self.assertTrue(
            THEME_BOOT.exists(),
            f"expected theme bootstrap at {THEME_BOOT}",
        )
        text = THEME_BOOT.read_text(encoding="utf8")
        # Must actually do something — set data-palette and data-mode so
        # the pre-paint flash is avoided.
        self.assertIn("data-palette", text)
        self.assertIn("data-mode", text)

    def test_committed_static_bundle_matches_source(self):
        """The committed `backend/static/` bundle is what production serves;
        a stale bundle has shipped twice (2.6.0, 2.6.1). The CI runs
        `scripts/check_static_sync.py`, but the *content* of theme-boot.js
        must also agree with the source so a one-line CSP fix actually
        reaches users."""
        if not STATIC_BOOT.exists() or not STATIC_INDEX.exists():
            self.skipTest("backend/static not built yet")
        self.assertEqual(
            STATIC_BOOT.read_text(encoding="utf8"),
            THEME_BOOT.read_text(encoding="utf8"),
            "backend/static/theme-boot.js is stale relative to source",
        )
        self.assertIn(
            "theme-boot.js",
            STATIC_INDEX.read_text(encoding="utf8"),
            "backend/static/index.html still references the inline script",
        )


if __name__ == "__main__":
    unittest.main()
