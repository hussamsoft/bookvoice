from __future__ import annotations

import os
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from fastapi import FastAPI
from fastapi.testclient import TestClient

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


class ProtectLocalApiMiddlewareTests(unittest.TestCase):
    """End-to-end middleware integration for the protect_local_api gate."""

    def _build_app(self):
        from main import protect_local_api  # noqa: WPS433 - imported here for isolation

        app = FastAPI()
        app.middleware("http")(protect_local_api)

        @app.get("/api/ping")
        async def ping():
            return {"ok": True}

        @app.get("/")
        async def root():
            return {"ok": True}

        return app

    def setUp(self):
        try:
            self.app = self._build_app()
        except SyntaxError as exc:
            self.skipTest(f"backend/main.py not importable in this environment: {exc}")

    def test_loopback_origin_is_allowed(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BOOKVOICE_PUBLIC_ORIGIN", None)
            client = TestClient(self._build_app())
            response = client.get(
                "/api/ping",
                headers={"Origin": "http://127.0.0.1:8000", "Host": "127.0.0.1:8000"},
            )
            self.assertEqual(response.status_code, 200)
            self.assertIn("X-Content-Type-Options", response.headers)

    def test_external_origin_is_rejected_with_403(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BOOKVOICE_PUBLIC_ORIGIN", None)
            client = TestClient(self._build_app())
            response = client.get(
                "/api/ping",
                headers={"Origin": "https://evil.example.com", "Host": "127.0.0.1:8000"},
            )
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json()["detail"], "Browser origin is not allowed.")

    def test_listed_public_origin_is_allowed(self):
        with patch.dict(os.environ, {"BOOKVOICE_PUBLIC_ORIGIN": "https://voice.example.com"}):
            client = TestClient(self._build_app())
            response = client.get(
                "/api/ping",
                headers={"Origin": "https://voice.example.com", "Host": "voice.example.com"},
            )
            self.assertEqual(response.status_code, 200)


if __name__ == "__main__":
    unittest.main()
