from __future__ import annotations

import asyncio
import io
import hashlib
import json
import os
import struct
import sys
import tempfile
import threading
import unittest
import wave
import zipfile
from concurrent.futures import Future
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from services import book_library_service as library  # noqa: E402
from routes import books as book_routes  # noqa: E402


def valid_wav_bytes() -> bytes:
    payload = io.BytesIO()
    with wave.open(payload, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24_000)
        output.writeframes(b"\x00\x00" * 2_400)
    return payload.getvalue()


def valid_float_wav_bytes() -> bytes:
    samples = struct.pack("<4f", 0.0, 0.25, -0.25, 0.0)
    fmt = struct.pack("<HHIIHH", 3, 1, 24_000, 96_000, 4, 32)
    body = b"fmt " + struct.pack("<I", len(fmt)) + fmt
    body += b"data" + struct.pack("<I", len(samples)) + samples
    return b"RIFF" + struct.pack("<I", len(body) + 4) + b"WAVE" + body


class BookLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = self.temp.name
        library._jobs.clear()
        library._archives.clear()

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.previous
        self.temp.cleanup()

    def test_pdf_identity_and_page_metadata_are_persistent(self):
        first = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        second = library.import_pdf(b"%PDF fixture", "renamed.pdf")
        self.assertEqual(first["id"], second["id"])

        page = library.save_page(first["id"], 1, "Wrapped page text", 3)
        loaded = library.get_page(first["id"], 1)
        self.assertEqual(page["textSha256"], loaded["textSha256"])
        self.assertEqual(library.get_book(first["id"])["pageCount"], 3)

    def test_pdf_path_import_streams_without_reading_the_file_into_memory(self):
        source = Path(self.temp.name) / "large.pdf"
        source.write_bytes(b"%PDF fixture")

        with patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file read")):
            imported = library.import_pdf_path(source, "Large Book.pdf")

        self.assertEqual(imported["title"], "Large Book")

    def test_archive_roundtrip_excludes_voice_samples(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id("Aria", "en")
        audio = library.book_dir(book["id"]) / "audio" / profile / "page-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, audio, [], 1.2, "Aria", "en")

        archive = library.create_archive(book["id"], profile)
        with zipfile.ZipFile(archive["path"]) as bundle:
            names = set(bundle.namelist())
        self.assertIn("manifest.json", names)
        self.assertIn("document/source.pdf", names)
        self.assertIn(f"audio/{profile}/page-1.wav", names)
        self.assertFalse(any("voice" in name.lower() for name in names))

        imported = library.import_bookvoice(Path(archive["path"]).read_bytes(), "copy.bookvoice")
        self.assertEqual(imported["id"], book["id"])

    def test_served_archive_cleanup_removes_record_and_temporary_file(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id(None, "en")
        audio = library.book_dir(book["id"]) / "audio" / profile / "page-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, audio, [], 0.1, None, "en")
        archive = library.create_archive(book["id"], profile)
        archive_path = Path(archive["path"])

        library.delete_archive(archive["id"])

        self.assertFalse(archive_path.exists())
        with self.assertRaises(FileNotFoundError):
            library.get_archive(archive["id"])

    def test_archive_path_import_streams_all_large_members(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id("Aria", "en")
        audio = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, audio, [], 0.1, "Aria", "en")
        archive = library.create_archive(book["id"], profile)
        original_read = zipfile.ZipFile.read

        def reject_large_member_reads(bundle, name, *args, **kwargs):
            member = name.filename if isinstance(name, zipfile.ZipInfo) else str(name)
            if member != "manifest.json":
                raise AssertionError(f"whole archive member read: {member}")
            return original_read(bundle, name, *args, **kwargs)

        with patch.object(zipfile.ZipFile, "read", new=reject_large_member_reads):
            imported = library.import_bookvoice_path(Path(archive["path"]), "copy.bookvoice")

        self.assertEqual(imported["id"], book["id"])

    def test_archive_import_replaces_stale_pages_and_audio_for_the_same_book(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id("Aria", "en")
        source = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        source.parent.mkdir(parents=True)
        source.write_bytes(valid_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, source, [], 0.1, "Aria", "en")
        archive = library.create_archive(book["id"], profile)

        library.save_page(book["id"], 2, "Stale local page", 2)
        stale_audio = library.book_dir(book["id"]) / "audio" / profile / "page-2.wav"
        stale_audio.write_bytes(valid_wav_bytes())

        library.import_bookvoice_path(Path(archive["path"]), "copy.bookvoice")

        self.assertFalse((library.book_dir(book["id"]) / "pages" / "2.json").exists())
        self.assertFalse(stale_audio.exists())
        self.assertEqual(library.get_book(book["id"])["pageCount"], 1)

    def test_prepared_pages_accept_torchaudio_float_wav_output(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id(None, "en")
        audio = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_float_wav_bytes())

        page = library.mark_page_audio(book["id"], profile, 1, audio, [], 0.1, None, "en")

        self.assertEqual(page["audio"]["profileId"], profile)
        self.assertTrue(library.has_valid_page_audio(book["id"], profile, 1))
        manifest = library.get_book(book["id"])
        self.assertEqual(manifest["activeProfileId"], profile)
        self.assertIn(f"audio/{profile}/page-1.wav", manifest["audioChecksums"])

    def test_mark_page_audio_hashes_the_wav_only_once(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id(None, "en")
        source = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        source.parent.mkdir(parents=True)
        source.write_bytes(valid_wav_bytes())
        target = library.page_audio_path(book["id"], profile, 1)

        with patch.object(library, "_sha256_file", wraps=library._sha256_file) as sha256_file:
            library.mark_page_audio(book["id"], profile, 1, source, [], 0.1, None, "en")

        target_hashes = [call for call in sha256_file.call_args_list if call.args[0] == target]
        self.assertEqual(len(target_hashes), 1)

    def test_mark_page_audio_replaces_the_cached_wav_atomically(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id(None, "en")
        source = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        source.parent.mkdir(parents=True)
        source.write_bytes(valid_wav_bytes())

        with patch.object(library.os, "replace", wraps=os.replace) as replace:
            library.mark_page_audio(book["id"], profile, 1, source, [], 0.1, None, "en")

        self.assertTrue(any(call.args[1] == library.page_audio_path(book["id"], profile, 1) for call in replace.call_args_list))

    def test_mark_page_audio_rejects_generation_for_stale_page_text(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        original = library.save_page(book["id"], 1, "Original page", 1)
        profile = library.profile_id(None, "en")
        source = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        source.parent.mkdir(parents=True)
        source.write_bytes(valid_wav_bytes())
        library.save_page(book["id"], 1, "Edited page", 1)

        with self.assertRaisesRegex(ValueError, "changed while narration was generating"):
            library.mark_page_audio(
                book["id"], profile, 1, source, [], 0.1, None, "en",
                expected_text_sha256=original["textSha256"],
            )

        self.assertFalse(library.page_audio_path(book["id"], profile, 1).exists())

    def test_cache_generated_page_reuses_completed_interactive_narration(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        session_audio = Path(self.temp.name) / "sessions" / "reader-session" / "page.wav"
        session_audio.parent.mkdir(parents=True)
        session_audio.write_bytes(valid_wav_bytes())

        cached = library.cache_generated_page(
            book["id"], 1, "Page one", "/sessions/reader-session/page.wav",
            [{"word": "Page", "start_s": 0.0, "end_s": 0.05}], 0.1, None, "en",
        )

        profile = library.profile_id(None, "en")
        self.assertEqual(cached["audio"]["profileId"], profile)
        self.assertTrue(library.is_page_prepared(book["id"], profile, 1))

    def test_cache_generated_page_rejects_stale_text(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Current text", 1)
        session_audio = Path(self.temp.name) / "sessions" / "reader-session" / "page.wav"
        session_audio.parent.mkdir(parents=True)
        session_audio.write_bytes(valid_wav_bytes())

        with self.assertRaisesRegex(ValueError, "does not match"):
            library.cache_generated_page(
                book["id"], 1, "Old text", "/sessions/reader-session/page.wav",
                [], 0.1, None, "en",
            )

    def test_page_audio_readiness_does_not_load_the_entire_wav_into_memory(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id(None, "en")
        audio = library.page_audio_path(book["id"], profile, 1)
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_wav_bytes())

        with patch.object(Path, "read_bytes", side_effect=AssertionError("full WAV read")):
            self.assertTrue(library.has_valid_page_audio(book["id"], profile, 1))

    def test_page_audio_path_rejects_profile_traversal(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")

        with self.assertRaisesRegex(ValueError, "profile id"):
            library.page_audio_path(book["id"], "../../outside", 1)

    def test_manifest_profile_recovers_audio_without_legacy_page_pointer(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id("Aria", "en")
        source = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        source.parent.mkdir(parents=True)
        source.write_bytes(valid_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, source, [], 0.1, "Aria", "en")

        page_path = library.book_dir(book["id"]) / "pages" / "1.json"
        metadata = json.loads(page_path.read_text(encoding="utf-8"))
        metadata.pop("audio")
        page_path.write_text(json.dumps(metadata), encoding="utf-8")

        self.assertTrue(library.is_page_prepared(book["id"], profile, 1, metadata))

    def test_prepared_page_route_exposes_manifest_owned_audio(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id("Aria", "en")
        source = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        source.parent.mkdir(parents=True)
        source.write_bytes(valid_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, source, [], 0.1, "Aria", "en")
        page_path = library.book_dir(book["id"]) / "pages" / "1.json"
        metadata = json.loads(page_path.read_text(encoding="utf-8"))
        metadata.pop("audio")
        page_path.write_text(json.dumps(metadata), encoding="utf-8")

        response = asyncio.run(book_routes.get_prepared_page(book["id"], profile, 1))

        self.assertIn("audioUrl", response)

    def test_preparation_regenerates_a_page_with_stale_completed_metadata(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id(None, "en")
        stale_audio = library.page_audio_path(book["id"], profile, 1)
        stale_audio.parent.mkdir(parents=True)
        stale_audio.write_bytes(valid_wav_bytes())
        manifest_path = library.book_dir(book["id"]) / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["profiles"] = {
            profile: {
                "id": profile,
                "voiceId": None,
                "languageId": "en",
                "completedPages": [1],
            }
        }
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        session = f"book-{book['id'][:12]}"
        generated = Path(self.temp.name) / "sessions" / session / "fresh.wav"
        generated.parent.mkdir(parents=True)
        generated.write_bytes(valid_wav_bytes())
        future = Future()
        future.set_result({
            "audio_url": f"/sessions/{session}/fresh.wav",
            "word_timings": [],
            "duration_s": 0.1,
        })
        job_id = "stale-page-job"
        library._jobs[job_id] = {
            "id": job_id,
            "bookId": book["id"],
            "profileId": profile,
            "voiceId": None,
            "languageId": "en",
            "status": "QUEUED",
            "completedPages": [],
            "totalPages": 1,
            "currentPage": None,
            "error": None,
            "cancelRequested": False,
        }

        with patch("services.tts_service.submit_tts", return_value=future):
            library._run_preparation(job_id, None, "en")

        page = library.get_page(book["id"], 1)
        self.assertEqual(page["audio"]["profileId"], profile)
        self.assertEqual(library._jobs[job_id]["status"], "COMPLETED")

    def test_preparation_retries_when_page_text_changes_during_generation(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Original page", 1)
        profile = library.profile_id(None, "en")
        session = f"book-{book['id'][:12]}"
        generated = Path(self.temp.name) / "sessions" / session
        generated.mkdir(parents=True)
        (generated / "old.wav").write_bytes(valid_wav_bytes())
        (generated / "new.wav").write_bytes(valid_wav_bytes())
        results = iter(("old.wav", "new.wav"))

        def submit(*_args, **_kwargs):
            name = next(results)
            if name == "old.wav":
                library.save_page(book["id"], 1, "Edited page", 1)
            future = Future()
            future.set_result({
                "audio_url": f"/sessions/{session}/{name}",
                "word_timings": [],
                "duration_s": 0.1,
            })
            return future

        job_id = "edited-page-job"
        library._jobs[job_id] = {
            "id": job_id, "bookId": book["id"], "profileId": profile,
            "voiceId": None, "languageId": "en", "status": "QUEUED",
            "completedPages": [], "totalPages": 1, "currentPage": None,
            "error": None, "cancelRequested": False,
        }

        with patch("services.tts_service.submit_tts", side_effect=submit) as submit_tts:
            library._run_preparation(job_id, None, "en")

        self.assertEqual(submit_tts.call_count, 2)
        self.assertEqual(library.get_page(book["id"], 1)["text"], "Edited page")
        self.assertEqual(library._jobs[job_id]["status"], "COMPLETED")

    def test_interactive_cache_rejects_page_edited_during_audio_promotion(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        original = library.save_page(book["id"], 1, "Original page", 1)
        session = Path(self.temp.name) / "sessions" / "reader-session"
        session.mkdir(parents=True)
        (session / "page.wav").write_bytes(valid_wav_bytes())
        real_mark_page_audio = library.mark_page_audio

        def edit_then_promote(*args, **kwargs):
            library.save_page(book["id"], 1, "Edited page", 1)
            return real_mark_page_audio(*args, **kwargs)

        with patch.object(library, "mark_page_audio", side_effect=edit_then_promote):
            with self.assertRaisesRegex(ValueError, "Page text changed"):
                library.cache_generated_page(
                    book["id"], 1, original["text"], "/sessions/reader-session/page.wav",
                    [], 0.1, None, "en",
                )

        self.assertNotIn("audio", library.get_page(book["id"], 1))

    def test_deleting_book_stops_and_removes_its_runtime_job(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        future = Future()
        worker = Mock()
        worker.is_alive.return_value = False
        library._jobs["delete-job"] = {
            "id": "delete-job", "bookId": book["id"], "profileId": library.profile_id(None, "en"),
            "voiceId": None, "languageId": "en", "status": "RUNNING",
            "completedPages": [], "totalPages": 1, "currentPage": 1,
            "error": None, "cancelRequested": False, "_future": future, "_thread": worker,
        }

        library.delete_book(book["id"])

        self.assertTrue(future.cancelled())
        worker.join.assert_called_once()
        self.assertNotIn("delete-job", library._jobs)
        self.assertFalse(library.book_dir(book["id"]).exists())

    def test_book_summary_identifies_the_active_prepared_profile(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id("Aria", "en")
        audio = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, audio, [], 0.1, "Aria", "en")

        summary = library.list_books()[0]

        self.assertEqual(summary["activeProfileId"], profile)
        self.assertEqual(summary["profiles"][0]["readyPages"], [1])

    def test_book_summary_does_not_report_corrupt_completed_audio_as_ready(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id("Aria", "en")
        audio = library.page_audio_path(book["id"], profile, 1)
        audio.parent.mkdir(parents=True)
        audio.write_bytes(b"RIFF" + b"\x00" * 128)
        manifest_path = library.book_dir(book["id"]) / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["profiles"] = {
            profile: {
                "id": profile,
                "voiceId": "Aria",
                "languageId": "en",
                "completedPages": [1],
            }
        }
        manifest["activeProfileId"] = profile
        manifest["audioChecksums"] = {
            f"audio/{profile}/page-1.wav": library._sha256_file(audio)
        }
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        summary = library.list_books()[0]

        self.assertEqual(summary["profiles"][0]["readyPages"], [])

    def test_preparation_rejects_missing_page_text_before_starting_a_job(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Only page one is extracted", 3)

        with patch.object(library.threading, "Thread") as thread:
            with self.assertRaisesRegex(ValueError, "pages 2, 3"):
                library.start_preparation(book["id"], None, "en")

        thread.assert_not_called()
        self.assertFalse(library._jobs)

    def test_concurrent_preparation_starts_deduplicate_one_job(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        barrier = threading.Barrier(3)
        results = []
        failures = []
        real_thread = threading.Thread

        def start():
            try:
                barrier.wait()
                results.append(library.start_preparation(book["id"], None, "en"))
            except Exception as exc:  # pragma: no cover - asserted below
                failures.append(exc)

        with patch.object(library.threading, "Thread") as worker_thread:
            callers = [real_thread(target=start) for _ in range(2)]
            for caller in callers:
                caller.start()
            barrier.wait()
            for caller in callers:
                caller.join(timeout=5)

        self.assertFalse(failures)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["id"], results[1]["id"])
        self.assertEqual(len(library._jobs), 1)
        worker_thread.assert_called_once()

    def test_preparation_finishes_immediately_when_profile_is_already_complete(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id("Aria", "en")
        audio = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, audio, [], 0.1, "Aria", "en")

        with patch.object(library.threading, "Thread") as thread:
            job = library.start_preparation(book["id"], "Aria", "en")

        self.assertEqual(job["status"], "COMPLETED")
        self.assertEqual(job["completedPages"], [1])
        thread.assert_not_called()

    def test_immediately_completed_preparation_is_retained(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id("Aria", "en")
        audio = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, audio, [], 0.1, "Aria", "en")

        with patch.object(library.threading, "Thread"):
            first = library.start_preparation(book["id"], "Aria", "en")
            library._prune_runtime_records()

        self.assertEqual(library.get_preparation(first["id"])["status"], "COMPLETED")

    def test_preparation_reports_pages_completed_before_resume(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 2)
        library.save_page(book["id"], 2, "Page two", 2)
        profile = library.profile_id(None, "en")
        audio = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, audio, [], 0.1, None, "en")

        with patch.object(library.threading, "Thread"):
            job = library.start_preparation(book["id"], None, "en")

        self.assertEqual(job["status"], "QUEUED")
        self.assertEqual(job["completedPages"], [1])

    def test_reopening_interrupted_preparation_returns_only_serializable_state(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id(None, "en")
        future = Future()
        library._jobs["resumed-job"] = {
            "id": "resumed-job",
            "bookId": book["id"],
            "profileId": profile,
            "voiceId": None,
            "languageId": "en",
            "status": "RUNNING",
            "completedPages": [],
            "totalPages": 1,
            "currentPage": 1,
            "error": None,
            "cancelRequested": False,
            "_future": future,
        }

        resumed = library.start_preparation(book["id"], None, "en")

        self.assertNotIn("_future", resumed)
        json.dumps(resumed)

    def test_running_preparation_cancels_only_its_generation(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        job_id = "cancel-running-job"
        library._jobs[job_id] = {
            "id": job_id,
            "bookId": book["id"],
            "profileId": library.profile_id(None, "en"),
            "voiceId": None,
            "languageId": "en",
            "status": "RUNNING",
            "completedPages": [],
            "totalPages": 1,
            "currentPage": 1,
            "error": None,
            "cancelRequested": False,
        }

        cancellation = Mock()
        library._jobs[job_id]["_cancel"] = cancellation
        with patch("services.tts_service.bump_generation") as bump_generation:
            cancelled = library.cancel_preparation(job_id)

        self.assertEqual(cancelled["status"], "CANCELLED")
        cancellation.cancel.assert_called_once()
        bump_generation.assert_not_called()
        persisted = library.get_book(book["id"])["preparation"]
        self.assertEqual(persisted["status"], "CANCELLED")

    def test_preparation_cancellation_is_idempotent_after_job_state_is_gone(self):
        cancelled = library.cancel_preparation("already-gone-job")

        self.assertEqual(cancelled["id"], "already-gone-job")
        self.assertEqual(cancelled["status"], "CANCELLED")

    def test_saving_unchanged_page_text_preserves_prepared_audio(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id(None, "en")
        audio = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_float_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, audio, [], 0.1, None, "en")

        saved = library.save_page(book["id"], 1, "Page one", 1)

        self.assertEqual(saved["audio"]["profileId"], profile)
        self.assertTrue(library.has_valid_page_audio(book["id"], profile, 1))

    def test_editing_page_text_invalidates_its_prepared_audio(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id(None, "en")
        audio = library.book_dir(book["id"]) / "scratch" / "page-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_float_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, audio, [], 0.1, None, "en")

        saved = library.save_page(book["id"], 1, "Edited page one", 1)

        self.assertNotIn("audio", saved)
        self.assertFalse(library.has_valid_page_audio(book["id"], profile, 1))
        completed = library.get_book(book["id"])["profiles"][profile]["completedPages"]
        self.assertNotIn(1, completed)

    def test_legacy_wav_validation_failure_is_recovered_once_when_library_opens(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        manifest_path = library.book_dir(book["id"]) / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["preparation"] = {
            "id": "legacy-job",
            "bookId": book["id"],
            "profileId": library.profile_id(None, "en"),
            "voiceId": None,
            "languageId": "en",
            "status": "FAILED",
            "completedPages": [],
            "totalPages": 1,
            "currentPage": None,
            "error": "Prepared narration is not a valid WAV file.",
        }
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        listed = library.list_books()

        self.assertEqual(listed[0]["preparation"]["status"], "PAUSED")
        self.assertIsNone(listed[0]["preparation"]["error"])
        self.assertTrue(listed[0]["preparation"]["legacyWavRecoveryAttempted"])
        persisted = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["preparation"]["status"], "PAUSED")

    def test_nonlegacy_preparation_failure_stays_failed_when_library_opens(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        manifest_path = library.book_dir(book["id"]) / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["preparation"] = {
            "id": "failed-job",
            "bookId": book["id"],
            "status": "FAILED",
            "error": "The voice model ran out of memory.",
        }
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        listed = library.list_books()

        self.assertEqual(listed[0]["preparation"]["status"], "FAILED")
        self.assertEqual(listed[0]["preparation"]["error"], "The voice model ran out of memory.")

    def test_archive_rejects_path_traversal(self):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as bundle:
            bundle.writestr("../outside.txt", "bad")
            bundle.writestr("manifest.json", "{}")
        with self.assertRaises(ValueError):
            library.import_bookvoice(payload.getvalue(), "bad.bookvoice")

    def test_archive_rejects_oversized_metadata_entries_before_extraction(self):
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as bundle:
            bundle.writestr("manifest.json", b"{}")
            bundle.writestr("pages/1.json", b"123456789")

        with patch.object(library, "MAX_ARCHIVE_METADATA_BYTES", 8):
            with self.assertRaisesRegex(ValueError, "metadata entry is too large"):
                library.import_bookvoice(payload.getvalue(), "oversized.bookvoice")

    def test_archive_rejects_an_audio_checksum_mismatch(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id("Aria", "en")
        audio = library.book_dir(book["id"]) / "audio" / profile / "page-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, audio, [], 1.2, "Aria", "en")
        archive = library.create_archive(book["id"], profile)

        tampered = io.BytesIO()
        with zipfile.ZipFile(archive["path"]) as source, zipfile.ZipFile(tampered, "w") as target:
            for name in source.namelist():
                payload = source.read(name)
                if name.endswith("page-1.wav"):
                    payload = b"RIFFtampered"
                target.writestr(name, payload)
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            library.import_bookvoice(tampered.getvalue(), "tampered.bookvoice")

    def test_archive_rejects_invalid_wav_even_when_checksum_matches(self):
        book = library.import_pdf(b"%PDF fixture", "A Book.pdf")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id("Aria", "en")
        audio = library.book_dir(book["id"]) / "audio" / profile / "page-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(valid_wav_bytes())
        library.mark_page_audio(book["id"], profile, 1, audio, [], 0.1, "Aria", "en")
        archive = library.create_archive(book["id"], profile)

        invalid_audio = b"RIFF" + (b"\x00" * 128)
        tampered = io.BytesIO()
        with zipfile.ZipFile(archive["path"]) as source, zipfile.ZipFile(tampered, "w") as target:
            manifest = json.loads(source.read("manifest.json"))
            audio_name = f"audio/{profile}/page-1.wav"
            manifest["audioChecksums"][audio_name] = hashlib.sha256(invalid_audio).hexdigest()
            for name in source.namelist():
                if name == "manifest.json":
                    target.writestr(name, json.dumps(manifest))
                elif name == audio_name:
                    target.writestr(name, invalid_audio)
                else:
                    target.writestr(name, source.read(name))

        with self.assertRaisesRegex(ValueError, "valid WAV"):
            library.import_bookvoice(tampered.getvalue(), "invalid-audio.bookvoice")


class BookUploadRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = self.temp.name

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.previous
        self.temp.cleanup()

    class FakeUpload:
        def __init__(self, chunks, filename="book.pdf"):
            self.chunks = list(chunks)
            self.read_sizes = []
            self.filename = filename

        async def read(self, size=-1):
            self.read_sizes.append(size)
            return self.chunks.pop(0) if self.chunks else b""

    def test_upload_staging_reads_bounded_chunks(self):
        upload = self.FakeUpload([b"%PDF", b" payload", b""])
        with tempfile.TemporaryDirectory() as temp_dir:
            path = asyncio.run(
                book_routes._stage_upload(upload, max_bytes=64, temp_dir=temp_dir)
            )
            try:
                self.assertEqual(path.read_bytes(), b"%PDF payload")
                self.assertTrue(upload.read_sizes)
                self.assertLessEqual(max(upload.read_sizes), book_routes.UPLOAD_CHUNK_BYTES)
                self.assertNotIn(-1, upload.read_sizes)
            finally:
                path.unlink(missing_ok=True)

    def test_oversized_upload_removes_its_partial_temp_file(self):
        upload = self.FakeUpload([b"1234", b"56", b""])
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaisesRegex(ValueError, "too large"):
                asyncio.run(
                    book_routes._stage_upload(upload, max_bytes=5, temp_dir=temp_dir)
                )
            self.assertEqual(list(Path(temp_dir).iterdir()), [])

    def test_import_route_uses_the_staged_file_and_removes_it(self):
        upload = self.FakeUpload([b"%PDF", b" fixture", b""])
        staged_paths = []

        def import_path(path, filename):
            staged_paths.append(Path(path))
            self.assertTrue(Path(path).is_file())
            self.assertEqual(filename, "book.pdf")
            return {"id": "book-id"}

        with patch.object(book_routes.library, "import_pdf_path", side_effect=import_path) as importer:
            response = asyncio.run(book_routes.import_book(upload))

        self.assertEqual(response, {"id": "book-id"})
        importer.assert_called_once()
        self.assertTrue(staged_paths)
        self.assertFalse(staged_paths[0].exists())


if __name__ == "__main__":
    unittest.main()
