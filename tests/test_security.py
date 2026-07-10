from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from services.security import is_allowed_browser_origin  # noqa: E402


class BrowserOriginTests(unittest.TestCase):
    def test_allows_local_app_origins_and_requests_without_origin(self):
        self.assertTrue(is_allowed_browser_origin(None))
        self.assertTrue(is_allowed_browser_origin("http://127.0.0.1:8000"))
        self.assertTrue(is_allowed_browser_origin("http://localhost:5173"))

    def test_rejects_unrelated_websites_and_lookalike_hosts(self):
        self.assertFalse(is_allowed_browser_origin("https://example.com"))
        self.assertFalse(is_allowed_browser_origin("http://localhost.evil.test"))
        self.assertFalse(is_allowed_browser_origin("null"))


if __name__ == "__main__":
    unittest.main()
