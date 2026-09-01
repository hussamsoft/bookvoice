"""Catch a committed backend/static bundle that predates the frontend source.

v2.6.0 added the five-palette theme system to frontend/src/styles/tokens.css
(`:root[data-palette][data-mode]`), but backend/static was never rebuilt, so
2.6.0 and 2.6.1 both shipped a bundle whose pre-paint script still set the
pre-theme `data-theme` attribute. The committed HTML and CSS agreed with each
other, so nothing noticed — only a comparison against the *source* catches it.

Deliberately static: no npm build, no hash comparison (bundle hashes vary by
toolchain), just the theming contract the source declares.
"""

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TOKENS_CSS = ROOT / "frontend" / "src" / "styles" / "tokens.css"
STATIC = ROOT / "backend" / "static"
INDEX_HTML = STATIC / "index.html"

# Attribute names the pre-paint script sets, e.g. setAttribute('data-mode', ...)
SET_ATTRIBUTE = re.compile(r"""setAttribute\(\s*['"](data-[\w-]+)['"]""")
# Root-scoped theme selectors the source declares. A selector chains several
# attributes (`:root[data-palette="paper"][data-mode="light"]`), so match the
# whole run of brackets and pull every attribute name out of it.
ROOT_SELECTOR = re.compile(r""":root((?:\[[^\]]*\])+)""")
DATA_ATTRIBUTE = re.compile(r"""(data-[\w-]+)""")
LOCAL_ASSET = re.compile(r"""(?:src|href)="(/assets/[^"]+)\"""")


def _theme_attributes(css: str) -> set[str]:
    return {
        name
        for selector in ROOT_SELECTOR.findall(css)
        for name in DATA_ATTRIBUTE.findall(selector)
    }


class StaticBundleFreshnessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for path in (TOKENS_CSS, INDEX_HTML):
            if not path.is_file():
                raise unittest.SkipTest(f"{path} missing")
        cls.index = INDEX_HTML.read_text(encoding="utf-8")
        cls.tokens = TOKENS_CSS.read_text(encoding="utf-8")
        cls.bundled_css = "\n".join(
            path.read_text(encoding="utf-8", errors="replace")
            for path in sorted(STATIC.glob("assets/*.css"))
        )

    def test_index_asset_references_exist(self):
        """A half-synced backend/static serves 404s for its own entry chunks."""
        refs = LOCAL_ASSET.findall(self.index)
        self.assertTrue(refs, "index.html references no /assets/ files")
        missing = sorted(ref for ref in refs if not (STATIC / ref.lstrip("/")).is_file())
        self.assertEqual(missing, [], f"backend/static is missing referenced assets: {missing}")

    def test_bundled_css_carries_the_source_theme_attributes(self):
        """The built CSS must key off the same root attributes tokens.css declares."""
        expected = _theme_attributes(self.tokens)
        self.assertTrue(expected, "tokens.css declares no :root[data-*] theme attributes")
        self.assertTrue(self.bundled_css, "backend/static ships no CSS bundle")
        missing = sorted(attr for attr in expected if f"[{attr}" not in self.bundled_css)
        self.assertEqual(
            missing,
            [],
            "backend/static CSS predates frontend/src/styles/tokens.css "
            f"(no rules for {missing}). Rebuild the frontend and re-sync backend/static.",
        )

    def test_pre_paint_script_sets_the_source_theme_attributes(self):
        """A stale inline script flashes the wrong theme before React mounts."""
        expected = _theme_attributes(self.tokens)
        applied = set(SET_ATTRIBUTE.findall(self.index))
        self.assertEqual(
            applied,
            expected,
            "index.html's pre-paint script sets "
            f"{sorted(applied)} but tokens.css themes on {sorted(expected)}.",
        )


if __name__ == "__main__":
    unittest.main()
