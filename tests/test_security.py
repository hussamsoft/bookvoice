from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from services.security import is_allowed_browser_origin, public_origins  # noqa: E402


class BrowserOriginTests(unittest.TestCase):
    def test_allows_local_app_origins_and_requests_without_origin(self):
        self.assertTrue(is_allowed_browser_origin(None))
        self.assertTrue(is_allowed_browser_origin("http://127.0.0.1:8000"))
        self.assertTrue(is_allowed_browser_origin("http://localhost:5173"))

    def test_rejects_unrelated_websites_and_lookalike_hosts(self):
        self.assertFalse(is_allowed_browser_origin("https://example.com"))
        self.assertFalse(is_allowed_browser_origin("http://localhost.evil.test"))
        self.assertFalse(is_allowed_browser_origin("null"))

    def test_desktop_default_trusts_no_public_origin(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BOOKVOICE_PUBLIC_ORIGIN", None)
            self.assertEqual(public_origins(), set())
            self.assertFalse(is_allowed_browser_origin("https://bookvoice.example.com"))

    def test_configured_public_origin_is_trusted_exactly(self):
        with patch.dict(
            os.environ, {"BOOKVOICE_PUBLIC_ORIGIN": "https://bookvoice.example.com"}
        ):
            self.assertTrue(is_allowed_browser_origin("https://bookvoice.example.com"))
            self.assertTrue(is_allowed_browser_origin("https://BookVoice.Example.com"))
            # A different scheme, port, or host is a different origin.
            self.assertFalse(is_allowed_browser_origin("http://bookvoice.example.com"))
            self.assertFalse(is_allowed_browser_origin("https://bookvoice.example.com:8443"))
            self.assertFalse(is_allowed_browser_origin("https://evil.bookvoice.example.com"))

    def test_same_public_origin_is_trusted_behind_an_https_reverse_proxy(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BOOKVOICE_PUBLIC_ORIGIN", None)
            self.assertTrue(
                is_allowed_browser_origin(
                    "https://voice.example.com",
                    request_scheme="http",
                    request_host="voice.example.com",
                    forwarded_proto="https",
                )
            )
            self.assertFalse(
                is_allowed_browser_origin(
                    "https://evil.example.com",
                    request_scheme="http",
                    request_host="voice.example.com",
                    forwarded_proto="https",
                )
            )

    def test_several_public_origins_can_be_configured(self):
        with patch.dict(
            os.environ,
            {"BOOKVOICE_PUBLIC_ORIGIN": "https://a.example.com, https://b.example.com"},
        ):
            self.assertEqual(
                public_origins(), {"https://a.example.com", "https://b.example.com"}
            )
            self.assertTrue(is_allowed_browser_origin("https://b.example.com"))

    def test_malformed_public_origins_are_discarded_not_trusted(self):
        with patch.dict(
            os.environ,
            {"BOOKVOICE_PUBLIC_ORIGIN": "not-a-url ftp://x.example.com https://u:p@x.example.com"},
        ):
            self.assertEqual(public_origins(), set())


if __name__ == "__main__":
    unittest.main()
