from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from routes import studio as studio_routes  # noqa: E402
from services import studio_service as studio  # noqa: E402


class StudioRouteContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = self.temp.name
        studio.reset_runtime_state_for_tests()
        app = FastAPI()
        app.include_router(studio_routes.router, prefix="/api/studio")
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        studio.reset_runtime_state_for_tests()
        if self.previous is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.previous
        self.temp.cleanup()

    def test_project_resources_are_camel_case_and_persistent(self):
        created = self.client.post("/api/studio/projects", json={"name": "Route project"})
        self.assertEqual(created.status_code, 201)
        payload = created.json()
        self.assertIn("generationSettings", payload)
        self.assertIn("createdAt", payload)
        project_id = payload["id"]

        updated = self.client.patch(
            f"/api/studio/projects/{project_id}",
            json={"script": "مرحبا", "languageId": "ar", "activeWorkflow": "REPAIR"},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["languageId"], "ar")

        listing = self.client.get("/api/studio/projects")
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.json()["projects"][0]["script"], "مرحبا")

    def test_consent_error_uses_studio_detail_contract(self):
        project = studio.create_project("Consent")
        response = self.client.post(
            f"/api/studio/projects/{project['id']}/profiles",
            json={
                "sourceId": "a" * 32,
                "name": "No consent",
                "startSec": 0,
                "endSec": 5,
                "consentConfirmed": False,
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"]["code"], "VOICE_CONSENT_REQUIRED")

    def test_long_narration_request_returns_a_202_job_resource(self):
        project = studio.create_project("Narration route")
        queued = {
            "id": "b" * 32,
            "projectId": project["id"],
            "kind": "NARRATION",
            "status": "QUEUED",
            "progress": 0,
            "canRetry": False,
        }
        with patch.object(studio_routes.studio, "submit_job", return_value=queued):
            response = self.client.post(
                f"/api/studio/projects/{project['id']}/narrations",
                json={
                    "text": "Typed directly in the app.",
                    "languageId": "en",
                    "voiceId": None,
                    "generationSettings": {
                        "pace": 1.1,
                        "expression": 0.6,
                        "temperature": 0.8,
                        "guidance": None,
                        "seed": 123,
                    },
                },
            )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["status"], "QUEUED")

    def test_video_preview_is_served_inline_as_mp4(self):
        preview = Path(self.temp.name) / "preview.mp4"
        preview.write_bytes(b"browser-video")

        with patch.object(studio_routes.studio, "asset_path", return_value=preview):
            response = self.client.get(
                "/api/studio/projects/"
                + "a" * 32
                + "/assets/"
                + "b" * 32
                + "/preview"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "video/mp4")
        self.assertTrue(response.headers["content-disposition"].startswith("inline;"))
        self.assertEqual(response.content, b"browser-video")

    def test_output_download_returns_a_persistent_background_job(self):
        project = studio.create_project("Download route")
        queued = {
            "id": "d" * 32,
            "projectId": project["id"],
            "kind": "SAVE_OUTPUT",
            "status": "QUEUED",
            "progress": 0,
            "canRetry": False,
        }
        with patch.object(studio_routes.studio, "submit_job", return_value=queued):
            response = self.client.post(
                f"/api/studio/projects/{project['id']}/outputs/{'e' * 32}/download"
            )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["kind"], "SAVE_OUTPUT")

    def test_open_project_folder_returns_a_path_free_confirmation(self):
        project = studio.create_project("Folder route")
        with patch.object(
            studio_routes.studio, "open_project_folder", return_value={"opened": True}
        ) as open_folder:
            response = self.client.post(
                f"/api/studio/projects/{project['id']}/open-folder"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"opened": True})
        open_folder.assert_called_once_with(project["id"])


if __name__ == "__main__":
    unittest.main()
