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
        self.assertTrue(
            is_allowed_browser_origin(
                "http://127.0.0.1:8000",
                request_scheme="http",
                request_host="127.0.0.1:8000",
            )
        )
        self.assertTrue(
            is_allowed_browser_origin(
                "http://localhost:5173",
                request_scheme="http",
                request_host="localhost:5173",
            )
        )
        # A loopback Origin arriving on a non-loopback Host is a rebinding
        # probe, not the local app.
        self.assertFalse(
            is_allowed_browser_origin(
                "http://127.0.0.1:8000",
                request_scheme="http",
                request_host="example.com",
            )
        )

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

    def test_a_proxy_claim_alone_trusts_nothing(self):
        # X-Forwarded-Proto is client-forgeable on an open port, so it is
        # ignored unless the deployment explicitly trusts its proxy. A
        # hosted origin must be listed, not inferred from Host/headers.
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BOOKVOICE_PUBLIC_ORIGIN", None)
            self.assertFalse(
                is_allowed_browser_origin(
                    "https://voice.example.com",
                    request_scheme="http",
                    request_host="voice.example.com",
                    forwarded_proto="https",
                )
            )
            self.assertFalse(
                is_allowed_browser_origin(
                    "https://voice.example.com",
                    request_scheme="http",
                    request_host="voice.example.com",
                    forwarded_proto="https",
                    trust_proxy_headers=True,
                )
            )
            self.assertFalse(
                is_allowed_browser_origin(
                    "https://evil.example.com",
                    request_scheme="http",
                    request_host="voice.example.com",
                    forwarded_proto="https",
                    trust_proxy_headers=True,
                )
            )

    def test_a_listed_origin_works_behind_a_proxy(self):
        with patch.dict(
            os.environ, {"BOOKVOICE_PUBLIC_ORIGIN": "https://voice.example.com"}
        ):
            self.assertTrue(
                is_allowed_browser_origin(
                    "https://voice.example.com",
                    request_scheme="http",
                    request_host="voice.example.com",
                    forwarded_proto="https",
                )
            )

    def test_rebinding_domain_resolving_to_loopback_is_rejected(self):
        # The attacker's page cannot forge Origin, but it can pick a hostname
        # that resolves to 127.0.0.1. The Host it arrives on is the
        # attacker's name, not loopback, so it must not be trusted.
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BOOKVOICE_PUBLIC_ORIGIN", None)
            self.assertFalse(
                is_allowed_browser_origin(
                    "http://rebind.example.com:8000",
                    request_scheme="http",
                    request_host="rebind.example.com:8000",
                )
            )
            self.assertFalse(
                is_allowed_browser_origin(
                    "http://127.0.0.1:8000",
                    request_scheme="http",
                    request_host="rebind.example.com:8000",
                )
            )
            # ...while the genuine same-origin loopback request still passes.
            self.assertTrue(
                is_allowed_browser_origin(
                    "http://127.0.0.1:8000",
                    request_scheme="http",
                    request_host="127.0.0.1:8000",
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
