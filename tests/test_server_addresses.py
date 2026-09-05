"""Contract for GET /api/server/addresses.

The launcher publishes where the server is reachable (bind address, LAN
addresses, tunnel URL) so the Settings panel can hand the address to another
device. It must never 500 and must degrade to available:false when no
launcher wrote the file — the common case for hosted/server-mode deploys.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from routes import server as server_routes  # noqa: E402


class ServerAddressesRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        os.environ["DATA_DIR"] = self.temp.name
        self.app = FastAPI()
        self.app.include_router(server_routes.router, prefix="/api/server")
        self.client = TestClient(self.app)

    def tearDown(self):
        os.environ.pop("DATA_DIR", None)

    def _write(self, payload):
        with open(server_routes.access_file_path(), "w", encoding="utf-8") as handle:
            json.dump(payload, handle)

    def test_reports_the_published_access_file(self):
        self._write({
            "available": True,
            "host": "0.0.0.0",
            "port": 8123,
            "lan": True,
            "addresses": ["192.168.1.81"],
            "tunnelUrl": "https://bookvoice.example.com",
        })
        response = self.client.get("/api/server/addresses")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["available"])
        self.assertEqual(body["port"], 8123)
        self.assertEqual(body["addresses"], ["192.168.1.81"])
        self.assertEqual(body["tunnelUrl"], "https://bookvoice.example.com")

    def test_without_a_file_it_is_available_false(self):
        response = self.client.get("/api/server/addresses")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["available"])

    def test_a_corrupt_file_is_available_false(self):
        with open(server_routes.access_file_path(), "w", encoding="utf-8") as handle:
            handle.write("{not json")
        response = self.client.get("/api/server/addresses")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["available"])

    def test_an_explicitly_unavailable_file_is_honored(self):
        self._write({"available": False})
        response = self.client.get("/api/server/addresses")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["available"])


if __name__ == "__main__":
    unittest.main()
