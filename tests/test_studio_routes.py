from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import unquote
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
        self.app = FastAPI()
        self.app.include_router(studio_routes.router, prefix="/api/studio")
        self.client = TestClient(self.app)
        self.client.cookies.set(
            studio_routes.DEVICE_COOKIE_NAME,
            studio.DEFAULT_DEVICE_ID,
        )

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
        self.assertNotIn("deviceId", listing.json()["projects"][0])

    def test_fresh_browser_receives_a_persistent_opaque_device_cookie(self):
        with TestClient(self.app) as fresh:
            response = fresh.get("/api/studio/projects")

            self.assertEqual(response.status_code, 200)
            device_id = fresh.cookies.get(studio_routes.DEVICE_COOKIE_NAME)
            self.assertRegex(device_id or "", r"^[0-9a-f]{32}$")
            self.assertIn("httponly", response.headers["set-cookie"].lower())
            self.assertIn("samesite=strict", response.headers["set-cookie"].lower())

    def test_devices_cannot_list_open_modify_or_delete_each_others_projects(self):
        device_a = "a" * 32
        device_b = "b" * 32
        with TestClient(self.app) as client_a, TestClient(self.app) as client_b:
            client_a.cookies.set(studio_routes.DEVICE_COOKIE_NAME, device_a)
            client_b.cookies.set(studio_routes.DEVICE_COOKIE_NAME, device_b)

            created = client_a.post(
                "/api/studio/projects",
                json={"name": "Device A private project"},
            )
            self.assertEqual(created.status_code, 201)
            project_id = created.json()["id"]

            self.assertEqual(client_b.get("/api/studio/projects").json()["projects"], [])
            self.assertEqual(
                client_b.get(f"/api/studio/projects/{project_id}").status_code,
                404,
            )
            self.assertEqual(
                client_b.patch(
                    f"/api/studio/projects/{project_id}",
                    json={"name": "Stolen"},
                ).status_code,
                404,
            )
            self.assertEqual(
                client_b.delete(f"/api/studio/projects/{project_id}").status_code,
                404,
            )

            reopened = client_a.get(f"/api/studio/projects/{project_id}")
            self.assertEqual(reopened.status_code, 200)
            self.assertEqual(reopened.json()["name"], "Device A private project")

    def test_project_assets_require_the_owning_device_cookie(self):
        device_a = "a" * 32
        device_b = "b" * 32
        output_id = "c" * 32
        with studio.device_scope(device_a):
            project = studio.create_project("Private media")
            root = studio.project_dir(project["id"])
            output = root / "outputs" / f"{output_id}.wav"
            output.write_bytes(b"device-audio")
            manifest_path = root / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["outputs"] = [{
                "id": output_id,
                "kind": "NARRATION",
                "path": f"outputs/{output_id}.wav",
            }]
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        asset_url = (
            f"/api/studio/projects/{project['id']}/assets/{output_id}/content"
        )
        with TestClient(self.app) as client_a, TestClient(self.app) as client_b:
            client_a.cookies.set(studio_routes.DEVICE_COOKIE_NAME, device_a)
            client_b.cookies.set(studio_routes.DEVICE_COOKIE_NAME, device_b)

            self.assertEqual(client_b.get(asset_url).status_code, 404)
            owned = client_a.get(asset_url)
            self.assertEqual(owned.status_code, 200)
            self.assertEqual(owned.content, b"device-audio")

    def test_output_download_is_an_attachment_for_the_requesting_device(self):
        project = studio.create_project("Phone download")
        output_id = "d" * 32
        root = studio.project_dir(project["id"])
        output = root / "outputs" / f"{output_id}.wav"
        output.write_bytes(b"phone-output")
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["outputs"] = [{
            "id": output_id,
            "kind": "NARRATION",
            "path": f"outputs/{output_id}.wav",
            "fileName": "phone narration.wav",
        }]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        refreshed = self.client.get(f"/api/studio/projects/{project['id']}")
        download_url = refreshed.json()["outputs"][0]["downloadUrl"]
        response = self.client.get(download_url)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"phone-output")
        disposition = unquote(response.headers["content-disposition"])
        self.assertIn("attachment", disposition)
        self.assertIn("phone narration.wav", disposition)

    def test_legacy_projects_are_hidden_until_one_device_claims_them(self):
        project = studio.create_project("Before device isolation")
        manifest_path = studio.project_dir(project["id"]) / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.pop("deviceId")
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        device_a = "a" * 32
        device_b = "b" * 32
        with TestClient(self.app) as client_a, TestClient(self.app) as client_b:
            client_a.cookies.set(studio_routes.DEVICE_COOKIE_NAME, device_a)
            client_b.cookies.set(studio_routes.DEVICE_COOKIE_NAME, device_b)

            before = client_a.get("/api/studio/projects").json()
            self.assertEqual(before["projects"], [])
            self.assertTrue(before["legacyProjectsAvailable"])

            claimed = client_b.post("/api/studio/legacy-projects/claim")
            self.assertEqual(claimed.status_code, 200)
            self.assertEqual(claimed.json()["claimed"], 1)
            self.assertEqual(claimed.json()["projects"][0]["id"], project["id"])
            self.assertFalse(claimed.json()["legacyProjectsAvailable"])

            self.assertEqual(
                client_a.get(f"/api/studio/projects/{project['id']}").status_code,
                404,
            )
            self.assertEqual(
                client_b.get(f"/api/studio/projects/{project['id']}").status_code,
                200,
            )

    def test_invalid_device_cookie_uses_the_studio_error_contract(self):
        with TestClient(self.app) as invalid:
            invalid.cookies.set(studio_routes.DEVICE_COOKIE_NAME, "not-a-device")
            response = invalid.get("/api/studio/projects")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"]["code"], "INVALID_DEVICE_ID")

    def test_device_header_repairs_a_stale_asset_cookie(self):
        device_a = "a" * 32
        device_b = "b" * 32
        with TestClient(self.app) as browser:
            browser.cookies.set(
                studio_routes.DEVICE_COOKIE_NAME,
                device_b,
                domain="testserver.local",
            )
            response = browser.get(
                "/api/studio/projects",
                headers={"X-BookVoice-Device-ID": device_a},
            )

            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                browser.cookies.get(
                    studio_routes.DEVICE_COOKIE_NAME,
                    domain="testserver.local",
                ),
                device_a,
            )

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

    def test_microphone_upload_marks_the_source_for_retention(self):
        project = studio.create_project("Recorded on phone")
        queued = {
            "id": "7" * 32,
            "projectId": project["id"],
            "kind": "MEDIA_IMPORT",
            "status": "QUEUED",
            "progress": 0,
            "canRetry": False,
        }
        with patch.object(studio_routes.studio, "submit_job", return_value=queued) as submit:
            response = self.client.post(
                f"/api/studio/projects/{project['id']}/sources",
                files={"file": ("recording.wav", b"phone recording", "audio/wav")},
                data={"captureMethod": "recording"},
            )

        self.assertEqual(response.status_code, 202)
        work = submit.call_args.args[2]
        with patch.object(
            studio_routes.studio,
            "import_source_path",
            return_value={"id": "8" * 32},
        ) as import_source, patch.object(studio_routes.studio, "update_job_progress"):
            result = work(job_id="7" * 32, cancel_event=threading.Event())

        self.assertEqual(result, {"sourceId": "8" * 32})
        self.assertEqual(import_source.call_args.kwargs["capture_method"], "recording")

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

    def test_conversion_route_queues_a_job_and_forwards_the_selected_region(self):
        project = studio.create_project("Conversion route")
        queued = {
            "id": "9" * 32,
            "projectId": project["id"],
            "kind": "VOICE_CONVERSION",
            "status": "QUEUED",
            "progress": 0,
            "canRetry": False,
        }
        with patch.object(studio_routes.studio, "submit_job", return_value=queued) as submit:
            response = self.client.post(
                f"/api/studio/projects/{project['id']}/conversions",
                json={
                    "sourceId": "1" * 32,
                    "startSec": 3.5,
                    "endSec": 20.25,
                    "targetVoiceId": "narrator",
                    "consentConfirmed": True,
                },
            )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["kind"], "VOICE_CONVERSION")
        self.assertEqual(submit.call_args.args[1], "VOICE_CONVERSION")

        work = submit.call_args.args[2]
        with patch.object(
            studio_routes.studio, "create_conversion", return_value={"id": "a" * 32}
        ) as convert, patch.object(studio_routes.studio, "update_job_progress"):
            result = work(job_id="9" * 32, cancel_event=None)

        self.assertEqual(result, {"outputId": "a" * 32})
        self.assertEqual(convert.call_args.kwargs["start_sec"], 3.5)
        self.assertEqual(convert.call_args.kwargs["end_sec"], 20.25)
        self.assertEqual(convert.call_args.kwargs["target_voice_id"], "narrator")
        self.assertTrue(convert.call_args.kwargs["consent_confirmed"])

    def test_conversion_route_rejects_missing_consent_and_ambiguous_targets(self):
        project = studio.create_project("Conversion guards")
        without_consent = self.client.post(
            f"/api/studio/projects/{project['id']}/conversions",
            json={"sourceId": "1" * 32, "targetVoiceId": "narrator", "consentConfirmed": False},
        )
        self.assertEqual(without_consent.status_code, 400)
        self.assertEqual(
            without_consent.json()["detail"]["code"], "VOICE_CONSENT_REQUIRED"
        )

        both_targets = self.client.post(
            f"/api/studio/projects/{project['id']}/conversions",
            json={
                "sourceId": "1" * 32,
                "targetVoiceId": "narrator",
                "targetSourceId": "2" * 32,
                "consentConfirmed": True,
            },
        )
        self.assertEqual(both_targets.status_code, 400)
        self.assertEqual(both_targets.json()["detail"]["code"], "INVALID_CONVERSION")

    def test_voice_profile_route_returns_settings_matched_to_the_recording(self):
        project = studio.create_project("Profile settings")
        queued = {
            "id": "8" * 32,
            "projectId": project["id"],
            "kind": "VOICE_PROFILE",
            "status": "QUEUED",
            "progress": 0,
            "canRetry": False,
        }
        suggested = {"pace": 1.05, "expression": 0.6, "temperature": 0.8, "guidance": None, "seed": None}
        with patch.object(studio_routes.studio, "submit_job", return_value=queued) as submit:
            response = self.client.post(
                f"/api/studio/projects/{project['id']}/profiles",
                json={
                    "sourceId": "1" * 32,
                    "name": "Imported voice",
                    "startSec": 0,
                    "endSec": 8,
                    "consentConfirmed": True,
                },
            )

        self.assertEqual(response.status_code, 202)
        work = submit.call_args.args[2]
        with patch.object(
            studio_routes.studio,
            "create_voice_profile",
            return_value={"id": "imported_voice", "suggestedSettings": suggested},
        ), patch.object(studio_routes.studio, "update_job_progress"):
            result = work(job_id="8" * 32, cancel_event=threading.Event())

        self.assertEqual(result["voiceId"], "imported_voice")
        self.assertEqual(result["suggestedSettings"], suggested)


if __name__ == "__main__":
    unittest.main()


class StudioProjectIdStatusContractTests(unittest.TestCase):
    """Malformed project ids must answer 404 PROJECT_NOT_FOUND, not 400."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = self.temp.name
        studio.reset_runtime_state_for_tests()
        self.app = FastAPI()
        self.app.include_router(studio_routes.router, prefix="/api/studio")
        self.client = TestClient(self.app)
        self.client.cookies.set(
            studio_routes.DEVICE_COOKIE_NAME,
            studio.DEFAULT_DEVICE_ID,
        )

    def tearDown(self):
        self.client.close()
        studio.reset_runtime_state_for_tests()
        if self.previous is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.previous
        self.temp.cleanup()

    def _assert_project_not_found(self, method, path, **kwargs):
        response = getattr(self.client, method)(path, **kwargs)
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(response.json()["detail"]["code"], "PROJECT_NOT_FOUND")

    def test_narration_with_malformed_id_answers_404(self):
        self._assert_project_not_found(
            "post",
            "/api/studio/projects/short/narrations",
            json={"text": "Hello world"},
        )

    def test_repair_with_malformed_id_answers_404(self):
        self._assert_project_not_found(
            "post",
            "/api/studio/projects/short/repairs",
            json={
                "assetId": "asset",
                "startSec": 0.0,
                "endSec": 1.0,
                "replacementText": "fixed",
            },
        )

    def test_conversion_with_malformed_id_answers_404(self):
        self._assert_project_not_found(
            "post",
            "/api/studio/projects/short/conversions",
            json={"sourceId": "asset"},
        )

    def test_import_source_with_malformed_id_answers_404(self):
        response = self.client.post(
            "/api/studio/projects/short/sources",
            files={"file": ("clip.wav", b"RIFF", "audio/wav")},
            data={"captureMethod": "upload"},
        )
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(response.json()["detail"]["code"], "PROJECT_NOT_FOUND")
