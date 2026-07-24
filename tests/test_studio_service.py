from __future__ import annotations

import json
import io
import os
import sys
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import Future


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from services import studio_service as studio  # noqa: E402


def wav_bytes(seconds: float = 1.0, rate: int = 24_000) -> bytes:
    payload = io.BytesIO()
    with wave.open(payload, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        frames = int(seconds * rate)
        output.writeframes(b"\x00\x10" * frames)
    return payload.getvalue()


class StudioProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = self.temp.name
        studio.reset_runtime_state_for_tests()

    def tearDown(self):
        studio.reset_runtime_state_for_tests()
        if self.previous is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.previous
        self.temp.cleanup()

    def test_project_create_rename_and_reopen_are_persistent(self):
        created = studio.create_project("First studio project")
        updated = studio.update_project(
            created["id"],
            {"name": "Renamed project", "script": "A locally saved draft."},
        )

        studio.reset_runtime_state_for_tests()
        reopened = studio.get_project(created["id"])

        self.assertEqual(updated["name"], "Renamed project")
        self.assertEqual(reopened["script"], "A locally saved draft.")
        self.assertEqual(reopened["schemaVersion"], 1)
        self.assertTrue((studio.project_dir(created["id"]) / "manifest.json").is_file())

    def test_duplicate_is_independent_and_does_not_share_manifest_state(self):
        original = studio.create_project("Original")
        studio.update_project(original["id"], {"script": "Original script"})

        copied = studio.duplicate_project(original["id"])
        studio.update_project(copied["id"], {"script": "Changed copy"})

        self.assertNotEqual(copied["id"], original["id"])
        self.assertEqual(studio.get_project(original["id"])["script"], "Original script")
        self.assertEqual(studio.get_project(copied["id"])["script"], "Changed copy")
        self.assertEqual(copied["name"], "Original copy")

    def test_delete_removes_only_the_named_project(self):
        first = studio.create_project("First")
        second = studio.create_project("Second")

        studio.delete_project(first["id"])

        with self.assertRaises(FileNotFoundError):
            studio.get_project(first["id"])
        self.assertEqual(studio.get_project(second["id"])["name"], "Second")

    def test_invalid_project_ids_cannot_escape_the_studio_root(self):
        with self.assertRaises(ValueError):
            studio.project_dir("..\\outside")
        with self.assertRaises(ValueError):
            studio.get_project("not-a-project")

    def test_interrupted_running_jobs_become_retryable_after_restart(self):
        project = studio.create_project("Interrupted work")
        manifest_path = studio.project_dir(project["id"]) / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["jobs"] = [
            {
                "id": "a" * 32,
                "kind": "MEDIA_IMPORT",
                "status": "RUNNING",
                "progress": 0.4,
                "createdAt": 1.0,
                "updatedAt": 1.0,
            }
        ]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        studio.reset_runtime_state_for_tests()
        reopened = studio.get_project(project["id"])

        self.assertEqual(reopened["jobs"][0]["status"], "INTERRUPTED")
        self.assertTrue(reopened["jobs"][0]["canRetry"])

    def test_imported_source_is_copied_and_exposed_only_through_asset_ids(self):
        project = studio.create_project("Media")
        staged = Path(self.temp.name) / "outside.wav"
        staged.write_bytes(wav_bytes())

        with patch.object(
            studio,
            "_probe_media",
            return_value={
                "durationSec": 1.0,
                "hasVideo": False,
                "sampleRate": 24_000,
                "channels": 1,
                "formatName": "wav",
            },
        ), patch.object(studio, "_extract_edit_audio") as extract:
            extract.side_effect = lambda source, target, **_: target.write_bytes(source.read_bytes())
            source = studio.import_source_path(project["id"], staged, "Interview.wav")

        reopened = studio.get_project(project["id"])
        self.assertEqual(reopened["sources"][0]["id"], source["id"])
        self.assertNotIn("path", reopened["sources"][0])
        self.assertNotIn(str(self.temp.name), json.dumps(reopened))
        self.assertEqual(staged.read_bytes(), wav_bytes())
        self.assertTrue(studio.asset_path(project["id"], source["id"], "original").is_file())
        self.assertTrue(studio.asset_path(project["id"], source["id"], "audio").is_file())
        self.assertGreater(len(source["waveformPeaks"]), 10)

    def test_video_import_creates_a_browser_compatible_preview_asset(self):
        project = studio.create_project("Video preview")
        staged = Path(self.temp.name) / "outside.mkv"
        staged.write_bytes(b"video-with-audio")

        with patch.object(
            studio,
            "_probe_media",
            return_value={
                "durationSec": 12.0,
                "hasVideo": True,
                "sampleRate": 24_000,
                "channels": 1,
                "formatName": "matroska",
            },
        ), patch.object(studio, "_extract_edit_audio") as extract, patch.object(
            studio, "_create_video_preview", create=True
        ) as create_preview:
            extract.side_effect = lambda _source, target, **_: target.write_bytes(wav_bytes(12))
            create_preview.side_effect = lambda _source, target: target.write_bytes(b"h264-aac-preview")
            source = studio.import_source_path(project["id"], staged, "Interview.mkv")

        create_preview.assert_called_once()
        self.assertTrue(source["previewUrl"].endswith("/preview"))
        preview = studio.asset_path(project["id"], source["id"], "preview")
        self.assertEqual(preview.suffix, ".mp4")
        self.assertEqual(preview.read_bytes(), b"h264-aac-preview")

    def test_media_probe_requires_an_audio_stream(self):
        with patch.object(
            studio,
            "_run_media_tool",
            return_value=json.dumps({"format": {"duration": "2"}, "streams": [{"codec_type": "video"}]}),
        ):
            with self.assertRaisesRegex(ValueError, "audio stream"):
                studio._probe_media(Path("video.mp4"))

    def test_media_probe_rejects_unbounded_duration(self):
        payload = {
            "streams": [{"codec_type": "audio", "sample_rate": "24000", "channels": 1}],
            "format": {"duration": str(studio.MAX_SOURCE_DURATION_SEC + 1), "format_name": "wav"},
        }
        with patch.object(studio, "_run_media_tool", return_value=json.dumps(payload)):
            with self.assertRaisesRegex(ValueError, "six hours"):
                studio._probe_media(Path("long.wav"))

    def test_generation_settings_are_bounded_and_canonical(self):
        settings = studio.validate_generation_settings(
            {"pace": 1.1, "expression": 0.7, "temperature": 0.9, "guidance": 0.3, "seed": 42}
        )
        self.assertEqual(settings["seed"], 42)
        self.assertEqual(settings["pace"], 1.1)

        with self.assertRaisesRegex(ValueError, "pace"):
            studio.validate_generation_settings({"pace": 2})
        with self.assertRaisesRegex(ValueError, "seed"):
            studio.validate_generation_settings({"seed": -1})

    def test_output_downloads_are_copied_without_overwriting_existing_files(self):
        project = studio.create_project("Downloads")
        root = studio.project_dir(project["id"])
        output_id = "9" * 32
        output_path = root / "outputs" / f"{output_id}.wav"
        output_path.write_bytes(b"generated-audio")
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["outputs"] = [{
            "id": output_id,
            "kind": "NARRATION",
            "fileName": "Downloads.wav",
            "format": "WAV",
            "path": f"outputs/{output_id}.wav",
            "sha256": studio._sha256_file(output_path),
        }]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        downloads = Path(self.temp.name) / "Downloads"
        downloads.mkdir()

        with patch.object(studio, "_windows_downloads_dir", return_value=downloads):
            first = studio.save_output_to_downloads(project["id"], output_id)
            second = studio.save_output_to_downloads(project["id"], output_id)

        self.assertEqual(first["fileName"], "Downloads.wav")
        self.assertEqual(second["fileName"], "Downloads (1).wav")
        self.assertEqual((downloads / first["fileName"]).read_bytes(), b"generated-audio")
        self.assertEqual((downloads / second["fileName"]).read_bytes(), b"generated-audio")
        self.assertNotIn("path", first)

    def test_cancelled_output_download_removes_partial_file(self):
        project = studio.create_project("Cancelled download")
        root = studio.project_dir(project["id"])
        output_id = "8" * 32
        output_path = root / "outputs" / f"{output_id}.wav"
        output_path.write_bytes(b"generated-audio")
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["outputs"] = [{
            "id": output_id,
            "kind": "NARRATION",
            "fileName": "cancelled.wav",
            "format": "WAV",
            "path": f"outputs/{output_id}.wav",
            "sha256": studio._sha256_file(output_path),
        }]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        downloads = Path(self.temp.name) / "Downloads"
        downloads.mkdir()
        cancelled = threading.Event()
        cancelled.set()

        with patch.object(studio, "_windows_downloads_dir", return_value=downloads):
            with self.assertRaisesRegex(RuntimeError, "cancelled"):
                studio.save_output_to_downloads(
                    project["id"], output_id, cancel_event=cancelled
                )

        self.assertEqual(list(downloads.iterdir()), [])

    def test_open_project_folder_uses_only_the_managed_project_root(self):
        project = studio.create_project("Reveal")
        with patch.object(studio, "_open_directory") as open_directory:
            result = studio.open_project_folder(project["id"])

        open_directory.assert_called_once_with(studio.project_dir(project["id"]).resolve())
        self.assertEqual(result, {"opened": True})
        with self.assertRaises(ValueError):
            studio.open_project_folder("..\\outside")

    def test_background_job_progress_and_result_are_persisted(self):
        project = studio.create_project("Jobs")

        def work(*, job_id, cancel_event):
            self.assertFalse(cancel_event.is_set())
            studio.update_job_progress(project["id"], job_id, 0.5, "Halfway")
            return {"assetId": "result-1"}

        submitted = studio.submit_job(project["id"], "TEST", work)
        deadline = time.time() + 3
        job = submitted
        while job["status"] not in {"COMPLETED", "FAILED", "CANCELLED"} and time.time() < deadline:
            time.sleep(0.01)
            job = studio.get_job(submitted["id"])

        self.assertEqual(job["status"], "COMPLETED")
        self.assertEqual(job["progress"], 1.0)
        self.assertEqual(job["result"], {"assetId": "result-1"})

    def test_cancelled_background_job_is_not_reclassified_as_failed(self):
        project = studio.create_project("Cancelled job")
        started = threading.Event()

        def work(*, job_id, cancel_event):
            started.set()
            self.assertTrue(cancel_event.wait(2))
            raise RuntimeError("Output download was cancelled.")

        submitted = studio.submit_job(project["id"], "SAVE_OUTPUT", work)
        self.assertTrue(started.wait(2))
        studio.cancel_job(submitted["id"])
        deadline = time.time() + 3
        job = studio.get_job(submitted["id"])
        while job["message"] == "Cancelling" and time.time() < deadline:
            time.sleep(0.01)
            job = studio.get_job(submitted["id"])

        self.assertEqual(job["status"], "CANCELLED")
        self.assertEqual(job["message"], "Cancelled")
        self.assertNotIn("error", job)

    def test_source_clip_creates_a_global_voice_profile_with_consent(self):
        project = studio.create_project("Profile")
        staged = Path(self.temp.name) / "voice.wav"
        staged.write_bytes(wav_bytes(10))
        with patch.object(
            studio,
            "_probe_media",
            return_value={
                "durationSec": 10.0,
                "hasVideo": False,
                "sampleRate": 24_000,
                "channels": 1,
                "formatName": "wav",
            },
        ), patch.object(studio, "_extract_edit_audio") as extract:
            extract.side_effect = lambda source, target, **_: target.write_bytes(source.read_bytes())
            source = studio.import_source_path(project["id"], staged, "voice.wav")

        with self.assertRaisesRegex(ValueError, "permission"):
            studio.create_voice_profile(
                project["id"], source["id"], "My Voice", 1, 7, consent_confirmed=False
            )

        with patch.object(studio, "_extract_profile_clip") as extract_profile:
            extract_profile.side_effect = (
                lambda _source, target, **_: target.write_bytes(wav_bytes(6))
            )
            profile = studio.create_voice_profile(
                project["id"], source["id"], "My Voice", 1, 7, consent_confirmed=True
            )

        self.assertEqual(profile["id"], "my_voice")
        self.assertTrue((Path(self.temp.name) / "voices" / "my_voice.wav").is_file())

    def test_profile_clip_must_be_between_five_and_thirty_seconds(self):
        project = studio.create_project("Profile bounds")
        project_path = studio.project_dir(project["id"])
        source_id = "b" * 32
        source_path = project_path / "sources" / f"{source_id}.wav"
        source_path.write_bytes(wav_bytes(40))
        manifest_path = project_path / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["sources"] = [{
            "id": source_id, "fileName": "long.wav", "mediaType": "AUDIO",
            "durationSec": 40.0, "path": f"sources/{source_id}.wav",
            "audioPath": f"sources/{source_id}.wav",
        }]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "5 and 30"):
            studio.create_voice_profile(
                project["id"], source_id, "Short", 0, 4, consent_confirmed=True
            )

    def test_narration_promotes_session_audio_into_immutable_project_output(self):
        project = studio.create_project("Narration")
        session_dir = Path(self.temp.name) / "sessions" / f'studio-{project["id"]}'
        session_dir.mkdir(parents=True)
        session_audio = session_dir / "generated.wav"
        session_audio.write_bytes(wav_bytes(1))
        generated = {
            "audio_url": f'/sessions/studio-{project["id"]}/generated.wav',
            "segments": [{"text": "Hello.", "start_s": 0, "end_s": 1}],
            "word_timings": [{"word": "Hello", "start_s": 0, "end_s": 1}],
            "duration_s": 1.0,
        }
        future = Future()
        future.set_result(generated)
        settings = studio.validate_generation_settings({"seed": 9})

        with patch("services.tts_service.submit_tts", return_value=future) as submit:
            output = studio.create_narration(
                project["id"], "Hello.", "en", "imported_voice", settings
            )

        self.assertEqual(output["kind"], "NARRATION")
        self.assertEqual(output["wordTimings"][0]["word"], "Hello")
        self.assertNotIn("path", output)
        self.assertTrue(studio.asset_path(project["id"], output["id"]).is_file())
        self.assertEqual(studio.get_project(project["id"])["script"], "Hello.")
        self.assertEqual(submit.call_args.args[0].name, "CURRENT")
        self.assertEqual(submit.call_args.args[4], "imported_voice")
        self.assertEqual(output["voiceId"], "imported_voice")

        second = studio.get_project(project["id"])["outputs"][0]
        self.assertEqual(second["id"], output["id"])

    def test_repair_replaces_only_selected_audio_and_preserves_total_duration(self):
        project = studio.create_project("Repair")
        project_path = studio.project_dir(project["id"])
        source_id = "c" * 32
        source_audio = project_path / "derived" / f"{source_id}.wav"
        source_audio.write_bytes(wav_bytes(4))
        original_digest = studio._sha256_file(source_audio)
        source_file = project_path / "sources" / f"{source_id}.wav"
        source_file.write_bytes(source_audio.read_bytes())
        manifest_path = project_path / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["sources"] = [{
            "id": source_id, "fileName": "source.wav", "mediaType": "AUDIO",
            "durationSec": 4.0, "sampleRate": 24_000, "channels": 1,
            "path": f"sources/{source_id}.wav", "audioPath": f"derived/{source_id}.wav",
        }]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        session_id = f'studio-{project["id"]}'
        replacement_dir = Path(self.temp.name) / "sessions" / session_id
        replacement_dir.mkdir(parents=True)
        replacement = replacement_dir / "replacement.wav"
        replacement.write_bytes(wav_bytes(1))
        future = Future()
        future.set_result({"audio_url": f"/sessions/{session_id}/replacement.wav"})

        with patch("services.tts_service.submit_tts", return_value=future) as submit:
            result = studio.create_repair(
                project["id"], source_id, 1.0, 2.0, "corrected phrase", "en", None,
                studio.validate_generation_settings({"seed": 2}),
            )

        repaired_path = studio.asset_path(project["id"], result["output"]["id"])
        with wave.open(str(repaired_path), "rb") as repaired_wav:
            self.assertAlmostEqual(repaired_wav.getnframes() / repaired_wav.getframerate(), 4.0, places=2)
        self.assertEqual(studio._sha256_file(source_audio), original_digest)
        self.assertEqual(result["repair"]["replacementText"], "corrected phrase")
        self.assertEqual(result["output"]["kind"], "REPAIR_AUDIO")
        from services import tts_service

        self.assertIs(submit.call_args.args[1], tts_service.narrate_studio_repair_text)

    def test_repair_rejects_extreme_time_stretch(self):
        import numpy as np

        replacement = np.ones((2_400, 1), dtype=np.float32)
        with self.assertRaisesRegex(ValueError, "selection"):
            studio._fit_replacement(replacement, 24_000, 24_000)

    def test_video_export_creates_a_new_asset_without_modifying_original(self):
        project = studio.create_project("Video export")
        root = studio.project_dir(project["id"])
        source_id = "d" * 32
        output_id = "e" * 32
        repair_id = "f" * 32
        original = root / "sources" / f"{source_id}.mp4"
        original.write_bytes(b"immutable-video")
        repaired_audio = root / "outputs" / f"{output_id}.wav"
        repaired_audio.write_bytes(wav_bytes(2))
        original_hash = studio._sha256_file(original)
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["sources"] = [{
            "id": source_id, "fileName": "clip.mp4", "mediaType": "VIDEO",
            "durationSec": 2.0, "path": f"sources/{source_id}.mp4",
            "audioPath": f"outputs/{output_id}.wav",
        }]
        manifest["outputs"] = [{
            "id": output_id, "kind": "REPAIR_AUDIO", "durationSec": 2.0,
            "path": f"outputs/{output_id}.wav", "repairId": repair_id,
        }]
        manifest["repairs"] = [{
            "id": repair_id, "assetId": source_id, "sourceKind": "SOURCE",
            "outputId": output_id, "status": "PREVIEW_READY",
        }]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        def fake_ffmpeg(_name, args, timeout=300):
            Path(args[-1]).write_bytes(b"repaired-video")
            return ""

        with patch.object(studio, "_run_media_tool", side_effect=fake_ffmpeg):
            exported = studio.export_repair_video(project["id"], repair_id)

        self.assertEqual(exported["kind"], "REPAIR_VIDEO")
        self.assertEqual(studio._sha256_file(original), original_hash)
        self.assertTrue(studio.asset_path(project["id"], exported["id"]).is_file())


if __name__ == "__main__":
    unittest.main()
