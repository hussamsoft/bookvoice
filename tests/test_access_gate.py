"""The hosted password gate, and proof the desktop path is unaffected."""
from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from routes import access as access_routes  # noqa: E402
from services import access_service  # noqa: E402


PASSWORD = "a-long-enough-password"


def _clear_env() -> dict:
    return {
        "BOOKVOICE_ACCESS_PASSWORD": "",
        "BOOKVOICE_SECRET_KEY": "",
        "BOOKVOICE_SERVER_MODE": "",
    }


class AccessServiceTests(unittest.TestCase):
    def test_desktop_default_requires_no_password(self):
        with patch.dict(os.environ, _clear_env()):
            self.assertFalse(access_service.auth_required())
            self.assertFalse(access_service.server_mode())
            # With no password configured every request is already authorized.
            self.assertTrue(access_service.is_valid_session(None))
            self.assertTrue(access_service.verify_password(None))

    def test_configured_password_gates_sessions(self):
        with patch.dict(os.environ, {"BOOKVOICE_ACCESS_PASSWORD": PASSWORD}):
            self.assertTrue(access_service.auth_required())
            self.assertFalse(access_service.is_valid_session(None))
            self.assertFalse(access_service.is_valid_session("garbage"))
            self.assertTrue(access_service.verify_password(PASSWORD))
            self.assertFalse(access_service.verify_password("wrong"))
            self.assertTrue(access_service.is_valid_session(access_service.issue_session()))

    def test_expired_and_tampered_sessions_are_rejected(self):
        with patch.dict(os.environ, {"BOOKVOICE_ACCESS_PASSWORD": PASSWORD}):
            expired = access_service.issue_session(
                now=time.time() - access_service.SESSION_TTL_SECONDS - 10
            )
            self.assertFalse(access_service.is_valid_session(expired))

            token = access_service.issue_session()
            expires, _, signature = token.partition(".")
            # Extending the expiry without a matching signature must not work.
            self.assertFalse(
                access_service.is_valid_session(f"{int(expires) + 86_400}.{signature}")
            )
            self.assertFalse(access_service.is_valid_session(f"{expires}.{signature[:-1]}x"))

    def test_changing_the_password_invalidates_outstanding_sessions(self):
        with patch.dict(os.environ, {"BOOKVOICE_ACCESS_PASSWORD": PASSWORD}):
            token = access_service.issue_session()
            self.assertTrue(access_service.is_valid_session(token))
        with patch.dict(os.environ, {"BOOKVOICE_ACCESS_PASSWORD": "a-different-password"}):
            self.assertFalse(access_service.is_valid_session(token))

    def test_explicit_secret_key_survives_a_password_change(self):
        environment = {
            "BOOKVOICE_ACCESS_PASSWORD": PASSWORD,
            "BOOKVOICE_SECRET_KEY": "stable-signing-key",
        }
        with patch.dict(os.environ, environment):
            token = access_service.issue_session()
        environment["BOOKVOICE_ACCESS_PASSWORD"] = "a-different-password"
        with patch.dict(os.environ, environment):
            self.assertTrue(access_service.is_valid_session(token))

    def test_capabilities_describe_the_running_environment(self):
        with patch.dict(os.environ, {**_clear_env(), "BOOKVOICE_SERVER_MODE": "1",
                                     "BOOKVOICE_ACCESS_PASSWORD": PASSWORD}):
            hosted = access_service.capabilities()
            self.assertTrue(hosted["serverMode"])
            self.assertTrue(hosted["authRequired"])
            self.assertFalse(hosted["localFileActions"])

        with patch.dict(os.environ, _clear_env()):
            desktop = access_service.capabilities()
            self.assertFalse(desktop["serverMode"])
            self.assertFalse(desktop["authRequired"])
            self.assertEqual(desktop["localFileActions"], os.name == "nt")

    def test_gated_paths_cover_the_api_and_generated_audio(self):
        with patch.dict(os.environ, {"BOOKVOICE_ACCESS_PASSWORD": PASSWORD}):
            self.assertTrue(access_service.requires_session("/api/studio/projects"))
            self.assertTrue(access_service.requires_session("/api/voices/"))
            self.assertTrue(access_service.requires_session("/sessions/studio-x/audio.wav"))
            # The gate itself and the launcher's readiness probe stay reachable,
            # or there would be no way to sign in and no way to start.
            self.assertFalse(access_service.requires_session("/api/access/"))
            self.assertFalse(access_service.requires_session("/api/health"))
            # Static UI assets are public; the API behind them is not.
            self.assertFalse(access_service.requires_session("/"))
            self.assertFalse(access_service.requires_session("/assets/index.js"))

    def test_no_path_is_gated_without_a_configured_password(self):
        with patch.dict(os.environ, _clear_env()):
            self.assertFalse(access_service.requires_session("/api/studio/projects"))
            self.assertFalse(access_service.requires_session("/sessions/x/a.wav"))

    def test_short_passwords_are_rejected_at_configuration_time(self):
        self.assertIsNone(access_service.password_error(PASSWORD))
        self.assertIn("at least", access_service.password_error("short"))
        self.assertIn("required", access_service.password_error(""))


class AccessRouteTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(access_routes.router, prefix="/api/access")
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()

    def test_sign_in_sets_a_session_cookie_and_reports_state(self):
        with patch.dict(
            os.environ,
            {"BOOKVOICE_ACCESS_PASSWORD": PASSWORD, "BOOKVOICE_COOKIE_SECURE": "0"},
        ):
            before = self.client.get("/api/access/")
            self.assertEqual(before.json(), {"authRequired": True, "authenticated": False})

            rejected = self.client.post("/api/access/", json={"password": "wrong"})
            self.assertEqual(rejected.status_code, 401)
            self.assertEqual(rejected.json()["detail"]["code"], "INVALID_PASSWORD")
            self.assertNotIn(access_service.COOKIE_NAME, self.client.cookies)

            accepted = self.client.post("/api/access/", json={"password": PASSWORD})
            self.assertEqual(accepted.status_code, 200)
            self.assertIn(access_service.COOKIE_NAME, self.client.cookies)
            self.assertTrue(self.client.get("/api/access/").json()["authenticated"])

            self.client.delete("/api/access/")
            self.assertFalse(self.client.get("/api/access/").json()["authenticated"])

    def test_session_cookie_is_http_only_and_same_site(self):
        with patch.dict(
            os.environ,
            {"BOOKVOICE_ACCESS_PASSWORD": PASSWORD, "BOOKVOICE_COOKIE_SECURE": "0"},
        ):
            response = self.client.post("/api/access/", json={"password": PASSWORD})
        header = response.headers["set-cookie"].lower()
        self.assertIn("httponly", header)
        self.assertIn("samesite=strict", header)

    def test_cookie_is_secure_by_default(self):
        with patch.dict(os.environ, {"BOOKVOICE_ACCESS_PASSWORD": PASSWORD}):
            os.environ.pop("BOOKVOICE_COOKIE_SECURE", None)
            response = self.client.post("/api/access/", json={"password": PASSWORD})
        self.assertIn("secure", response.headers["set-cookie"].lower())

    def test_desktop_mode_reports_no_gate(self):
        with patch.dict(os.environ, _clear_env()):
            state = self.client.get("/api/access/").json()
        self.assertEqual(state, {"authRequired": False, "authenticated": True})


if __name__ == "__main__":
    unittest.main()
