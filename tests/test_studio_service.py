from __future__ import annotations

import json
import io
import os
import struct
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
from services import storage_utils, voice_profile_service  # noqa: E402


def wav_bytes(seconds: float = 1.0, rate: int = 24_000) -> bytes:
    payload = io.BytesIO()
    with wave.open(payload, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        frames = int(seconds * rate)
        output.writeframes(b"\x00\x10" * frames)
    return payload.getvalue()


def extensible_wav_bytes(seconds: float = 1.0, rate: int = 24_000) -> bytes:
    frames = int(seconds * rate)
    audio = b"\x00\x10" * frames
    channels = 1
    block_align = channels * 2
    byte_rate = rate * block_align
    pcm_guid = b"\x01\x00\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71"
    fmt = struct.pack(
        "<HHIIHHHHI16s",
        0xFFFE,
        channels,
        rate,
        byte_rate,
        block_align,
        16,
        22,
        16,
        0x4,
        pcm_guid,
    )
    body = b"fmt " + struct.pack("<I", len(fmt)) + fmt
    body += b"data" + struct.pack("<I", len(audio)) + audio
    return b"RIFF" + struct.pack("<I", len(body) + 4) + b"WAVE" + body


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

    def test_project_access_is_enforced_by_the_current_device_scope(self):
        device_a = "a" * 32
        device_b = "b" * 32
        with studio.device_scope(device_a):
            project = studio.create_project("Private to device A")
            self.assertEqual(studio.list_projects()[0]["id"], project["id"])
            self.assertNotIn("deviceId", project)

        with studio.device_scope(device_b):
            self.assertEqual(studio.list_projects(), [])
            with self.assertRaises(FileNotFoundError):
                studio.get_project(project["id"])
            with self.assertRaises(FileNotFoundError):
                studio.delete_project(project["id"])
            with self.assertRaises(FileNotFoundError):
                studio.open_project_folder(project["id"])

        with studio.device_scope(device_a):
            self.assertEqual(
                studio.get_project(project["id"])["name"],
                "Private to device A",
            )

    def test_background_jobs_keep_the_submitting_device_scope(self):
        device_a = "a" * 32
        device_b = "b" * 32
        observed_devices = []
        with studio.device_scope(device_a):
            project = studio.create_project("Device job")

            def work(*, job_id, cancel_event):
                observed_devices.append(studio.current_device_id())
                studio.update_job_progress(project["id"], job_id, 0.5, "Scoped")
                return {"device": studio.current_device_id()}

            submitted = studio.submit_job(project["id"], "TEST", work)

        with studio.device_scope(device_b):
            with self.assertRaises(FileNotFoundError):
                studio.get_job(submitted["id"])

        deadline = time.time() + 3
        with studio.device_scope(device_a):
            job = studio.get_job(submitted["id"])
            while job["status"] not in {"COMPLETED", "FAILED"} and time.time() < deadline:
                time.sleep(0.01)
                job = studio.get_job(submitted["id"])

        self.assertEqual(job["status"], "COMPLETED")
        self.assertEqual(job["result"], {"device": device_a})
        self.assertEqual(observed_devices, [device_a])

    def test_manifest_read_retries_a_transient_windows_sharing_violation(self):
        project = studio.create_project("Concurrent manifest")
        manifest_path = studio.project_dir(project["id"]) / "manifest.json"
        real_read = manifest_path.read_text
        attempts = 0

        def flaky_read(_path, *args, **kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise PermissionError("sharing violation")
            return real_read(*args, **kwargs)

        with patch.object(type(manifest_path), "read_text", new=flaky_read):
            reopened = studio.get_project(project["id"])

        self.assertEqual(reopened["id"], project["id"])
        self.assertEqual(attempts, 2)

    def test_manifest_write_retries_a_transient_windows_sharing_violation(self):
        target = Path(self.temp.name) / "manifest.json"
        real_replace = storage_utils.os.replace
        attempts = 0

        def flaky_replace(source, destination):
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise PermissionError("access denied")
            return real_replace(source, destination)

        with patch.object(storage_utils.os, "replace", side_effect=flaky_replace), patch.object(
            storage_utils.time, "sleep"
        ):
            studio._write_json_atomic(target, {"ok": True})

        self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"ok": True})
        self.assertEqual(attempts, 3)

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

    def test_waveform_accepts_phone_pcm_in_wave_format_extensible(self):
        path = Path(self.temp.name) / "phone.wav"
        path.write_bytes(extensible_wav_bytes())

        peaks = studio._waveform_peaks(path, buckets=20)

        self.assertEqual(len(peaks), 20)
        self.assertTrue(all(0.12 < peak < 0.13 for peak in peaks))

    def test_expired_microphone_recording_is_erased_without_touching_imports_or_voices(self):
        project = studio.create_project("Recording retention")
        staged = Path(self.temp.name) / "outside.wav"
        staged.write_bytes(wav_bytes())
        metadata = {
            "durationSec": 1.0,
            "hasVideo": False,
            "sampleRate": 24_000,
            "channels": 1,
            "formatName": "wav",
        }
        with patch.object(studio, "_probe_media", return_value=metadata), patch.object(
            studio, "_extract_edit_audio"
        ) as extract:
            extract.side_effect = lambda source, target, **_: target.write_bytes(source.read_bytes())
            recorded = studio.import_source_path(
                project["id"],
                staged,
                "recording-2026-07-28T18-10-51.wav",
                capture_method="recording",
            )
            uploaded = studio.import_source_path(
                project["id"],
                staged,
                "kept-forever.wav",
                capture_method="upload",
            )

        self.assertEqual(recorded["captureMethod"], "recording")
        self.assertAlmostEqual(
            recorded["expiresAt"] - recorded["createdAt"],
            studio.RECORDING_RETENTION_SEC,
            places=3,
        )
        self.assertEqual(uploaded["captureMethod"], "upload")
        self.assertNotIn("expiresAt", uploaded)
        root = studio.project_dir(project["id"])
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        recorded_paths = []
        for source in manifest["sources"]:
            if source["id"] == recorded["id"]:
                source["expiresAt"] = time.time() - 1
                recorded_paths = [root / source[key] for key in ("path", "audioPath", "waveformPath")]
            elif source["id"] == uploaded["id"]:
                source["createdAt"] = 1
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        shared_voice = Path(self.temp.name) / "voices" / "shared_voice.wav"
        shared_voice.parent.mkdir(parents=True, exist_ok=True)
        shared_voice.write_bytes(wav_bytes(6))

        reopened = studio.get_project(project["id"])

        self.assertEqual([source["id"] for source in reopened["sources"]], [uploaded["id"]])
        self.assertTrue(all(not path.exists() for path in recorded_paths))
        self.assertTrue(studio.asset_path(project["id"], uploaded["id"], "original").is_file())
        self.assertTrue(shared_voice.is_file())

    def test_legacy_bookvoice_microphone_filename_receives_retention_policy(self):
        project = studio.create_project("Legacy microphone recording")
        source_id = "f" * 32
        root = studio.project_dir(project["id"])
        source_path = root / "sources" / f"{source_id}.wav"
        audio_path = root / "derived" / f"{source_id}.wav"
        source_path.write_bytes(wav_bytes())
        audio_path.write_bytes(wav_bytes())
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["sources"] = [{
            "id": source_id,
            "fileName": "recording-2026-01-01T12-30-45.wav",
            "mediaType": "AUDIO",
            "durationSec": 1,
            "path": f"sources/{source_id}.wav",
            "audioPath": f"derived/{source_id}.wav",
            "createdAt": time.time() - studio.RECORDING_RETENTION_SEC - 1,
        }]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        self.assertEqual(studio.get_project(project["id"])["sources"], [])
        self.assertFalse(source_path.exists())
        self.assertFalse(audio_path.exists())

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

        submitted = studio.submit_job(project["id"], "TEST", work)
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
        with studio.device_scope("b" * 32):
            self.assertIn("my_voice", {item["id"] for item in voice_profile_service.list_profiles()})
            with self.assertRaises(FileNotFoundError):
                studio.get_project(project["id"])

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


class StudioVoiceConversionTests(unittest.TestCase):
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

    def _project_with_source(self, name: str, *, source_id: str, duration: float = 12.0) -> dict:
        project = studio.create_project(name)
        root = studio.project_dir(project["id"])
        (root / "sources" / f"{source_id}.wav").write_bytes(wav_bytes(duration))
        (root / "derived" / f"{source_id}.wav").write_bytes(wav_bytes(duration))
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["sources"] = [{
            "id": source_id,
            "fileName": "interview.wav",
            "mediaType": "AUDIO",
            "durationSec": duration,
            "sha256": "a" * 64,
            "path": f"sources/{source_id}.wav",
            "audioPath": f"derived/{source_id}.wav",
        }]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return project

    def _converted_future(self, project_id: str, seconds: float = 3.0) -> Future:
        session_dir = Path(self.temp.name) / "sessions" / f"studio-{project_id}"
        session_dir.mkdir(parents=True, exist_ok=True)
        (session_dir / "converted.wav").write_bytes(wav_bytes(seconds))
        future = Future()
        future.set_result({
            "audio_url": f"/sessions/studio-{project_id}/converted.wav",
            "duration_s": seconds,
            "sampleRate": 24_000,
            "windows": 2,
        })
        return future

    def test_conversion_to_saved_profile_produces_an_immutable_output(self):
        source_id = "1" * 32
        project = self._project_with_source("Convert", source_id=source_id)
        voices = Path(self.temp.name) / "voices"
        voices.mkdir(parents=True, exist_ok=True)
        (voices / "narrator.wav").write_bytes(wav_bytes(6))
        future = self._converted_future(project["id"])

        with patch("services.tts_service.submit_tts", return_value=future) as submit, \
                patch.object(studio, "_extract_clip") as extract:
            extract.side_effect = lambda _source, target, **_: target.write_bytes(wav_bytes(4))
            output = studio.create_conversion(
                project["id"],
                source_id,
                start_sec=2.0,
                end_sec=6.0,
                target_voice_id="narrator",
                consent_confirmed=True,
            )

        self.assertEqual(output["kind"], "CONVERSION")
        self.assertEqual(output["voiceId"], "narrator")
        self.assertEqual(output["startSec"], 2.0)
        self.assertEqual(output["endSec"], 6.0)
        self.assertNotIn("path", output)
        self.assertTrue(output["fileName"].endswith("-converted.wav"))
        self.assertTrue(studio.asset_path(project["id"], output["id"]).is_file())
        # The reference is the stored profile, not a copy of the source speaker.
        self.assertTrue(str(submit.call_args.args[3]).endswith("narrator.wav"))
        self.assertEqual(studio.get_project(project["id"])["voiceId"], "narrator")

    def test_conversion_can_take_its_target_voice_from_another_recording(self):
        source_id = "2" * 32
        target_id = "3" * 32
        project = self._project_with_source("Convert from file", source_id=source_id)
        root = studio.project_dir(project["id"])
        (root / "derived" / f"{target_id}.wav").write_bytes(wav_bytes(20))
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["sources"].append({
            "id": target_id,
            "fileName": "target-speaker.wav",
            "mediaType": "AUDIO",
            "durationSec": 20.0,
            "sha256": "b" * 64,
            "path": f"derived/{target_id}.wav",
            "audioPath": f"derived/{target_id}.wav",
        })
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        future = self._converted_future(project["id"])

        with patch("services.tts_service.submit_tts", return_value=future), \
                patch.object(studio, "_extract_clip") as extract:
            extract.side_effect = lambda _source, target, **_: target.write_bytes(wav_bytes(8))
            output = studio.create_conversion(
                project["id"],
                source_id,
                target_source_id=target_id,
                target_start_sec=0.0,
                target_end_sec=10.0,
                consent_confirmed=True,
            )

        self.assertEqual(output["kind"], "CONVERSION")
        self.assertIsNone(output["voiceId"])
        self.assertEqual(output["targetSourceId"], target_id)
        self.assertEqual(output["targetVoiceName"], "target-speaker.wav")
        # A file-sourced target must not leak into the global voice library.
        self.assertFalse((Path(self.temp.name) / "voices" / "target-speaker.wav").exists())
        self.assertIsNone(studio.get_project(project["id"])["voiceId"])

    def test_conversion_requires_consent_one_target_and_a_valid_region(self):
        source_id = "4" * 32
        project = self._project_with_source("Guards", source_id=source_id)

        with self.assertRaisesRegex(ValueError, "permission"):
            studio.create_conversion(
                project["id"], source_id, target_voice_id="narrator", consent_confirmed=False
            )
        with self.assertRaisesRegex(ValueError, "exactly one target"):
            studio.create_conversion(
                project["id"],
                source_id,
                target_voice_id="narrator",
                target_source_id="5" * 32,
                consent_confirmed=True,
            )
        with self.assertRaisesRegex(ValueError, "exactly one target"):
            studio.create_conversion(project["id"], source_id, consent_confirmed=True)
        with self.assertRaisesRegex(ValueError, "half a second"):
            studio.create_conversion(
                project["id"],
                source_id,
                start_sec=1.0,
                end_sec=1.2,
                target_voice_id="narrator",
                consent_confirmed=True,
            )
        with self.assertRaisesRegex(ValueError, "beyond the recording"):
            studio.create_conversion(
                project["id"],
                source_id,
                start_sec=0.0,
                end_sec=99.0,
                target_voice_id="narrator",
                consent_confirmed=True,
            )

    def test_conversion_rejects_a_missing_voice_profile(self):
        source_id = "6" * 32
        project = self._project_with_source("Missing voice", source_id=source_id)
        with self.assertRaisesRegex(FileNotFoundError, "target voice profile"):
            studio.create_conversion(
                project["id"], source_id, target_voice_id="not_here", consent_confirmed=True
            )

    def test_conversion_leaves_no_staging_files_behind(self):
        source_id = "7" * 32
        project = self._project_with_source("Staging", source_id=source_id)
        voices = Path(self.temp.name) / "voices"
        voices.mkdir(parents=True, exist_ok=True)
        (voices / "narrator.wav").write_bytes(wav_bytes(6))
        future = self._converted_future(project["id"])

        with patch("services.tts_service.submit_tts", return_value=future), \
                patch.object(studio, "_extract_clip") as extract:
            extract.side_effect = lambda _source, target, **_: target.write_bytes(wav_bytes(4))
            studio.create_conversion(
                project["id"],
                source_id,
                start_sec=1.0,
                end_sec=5.0,
                target_voice_id="narrator",
                consent_confirmed=True,
            )

        self.assertEqual(list((studio.studio_root() / "staging").iterdir()), [])

    def test_conversion_workflow_is_selectable_on_a_project(self):
        project = studio.create_project("Workflow")
        updated = studio.update_project(project["id"], {"activeWorkflow": "CONVERSION"})
        self.assertEqual(updated["activeWorkflow"], "CONVERSION")
        with self.assertRaisesRegex(ValueError, "Invalid Studio workflow"):
            studio.update_project(project["id"], {"activeWorkflow": "TRANSMOGRIFY"})


if __name__ == "__main__":
    unittest.main()
