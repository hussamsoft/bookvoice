"""Contract for the update endpoints.

The install route is the one that matters: it is the only API in the app whose
success means the process is about to exit, so it has to refuse every case
where exiting would strand the user with no app and no installer.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from routes import updates as update_routes  # noqa: E402
from services import update_service  # noqa: E402


class UpdateRouteContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patcher = patch.dict(os.environ, {"DATA_DIR": self.temp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.app = FastAPI()
        self.app.include_router(update_routes.router, prefix="/api/updates")
        self.client = TestClient(self.app)

    def test_get_reports_state_without_reaching_the_network(self):
        with patch.object(update_service, "supported", return_value=False):
            response = self.client.get("/api/updates/")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("current", body)
        self.assertFalse(body["updateAvailable"])

    def test_get_survives_a_network_failure(self):
        """Polling this must never turn into a 500 in the UI."""
        with patch.object(update_service, "supported", return_value=True):
            with patch.object(update_service, "enabled", return_value=True):
                with patch.object(
                    update_service, "_fetch_latest_tag", side_effect=OSError("offline")
                ):
                    response = self.client.get("/api/updates/")
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(response.json()["error"])

    def test_download_is_refused_off_windows_or_on_a_server(self):
        with patch.object(update_service, "supported", return_value=False):
            response = self.client.post("/api/updates/download", json={"version": "9.9.9"})
        self.assertEqual(response.status_code, 400)

    def test_download_refuses_a_version_that_is_not_newer(self):
        """Otherwise a crafted request could stage and install a downgrade."""
        with patch.object(update_service, "supported", return_value=True):
            with patch.object(update_service, "enabled", return_value=True):
                with patch.object(update_service, "app_version", return_value="2.6.3"):
                    with patch.object(update_service, "start_download") as start:
                        response = self.client.post(
                            "/api/updates/download", json={"version": "2.6.0"}
                        )
        self.assertEqual(response.status_code, 400)
        start.assert_not_called()

    def test_download_accepts_a_newer_version(self):
        with patch.object(update_service, "supported", return_value=True):
            with patch.object(update_service, "enabled", return_value=True):
                with patch.object(update_service, "app_version", return_value="2.6.3"):
                    with patch.object(
                        update_service, "start_download", return_value={"state": "downloading"}
                    ) as start:
                        response = self.client.post(
                            "/api/updates/download", json={"version": "2.7.0"}
                        )
        self.assertEqual(response.status_code, 202)
        start.assert_called_once_with("2.7.0")

    def test_install_conflicts_when_nothing_has_been_staged(self):
        with patch.object(update_service, "supported", return_value=True):
            response = self.client.post("/api/updates/install", json={"version": "2.7.0"})
        self.assertEqual(response.status_code, 409)

    def test_install_returns_before_the_process_exits(self):
        staged = Path(self.temp.name) / "updates" / "2.7.0" / update_service.LAUNCHER_ASSET
        staged.parent.mkdir(parents=True)
        staged.write_bytes(b"installer")
        with patch.object(update_service, "supported", return_value=True):
            with patch.object(update_service.threading, "Thread", return_value=MagicMock()):
                response = self.client.post(
                    "/api/updates/install", json={"version": "2.7.0"}
                )
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["version"], "2.7.0")
        self.assertTrue(update_service.pending_path().is_file())


if __name__ == "__main__":
    unittest.main()
