from __future__ import annotations

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

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from routes import audiobooks as audiobook_routes  # noqa: E402
from services import audiobook_export_service as exports  # noqa: E402
from services import book_library_service as library  # noqa: E402
from services import media_tools  # noqa: E402


def valid_wav_bytes() -> bytes:
    payload = io.BytesIO()
    with wave.open(payload, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24_000)
        output.writeframes(b"\x00\x00" * 2_400)
    return payload.getvalue()


class FakeMediaTools:
    """Stands in for the packaged ffmpeg/ffprobe binaries.

    ffprobe calls return a per-page duration; ffmpeg calls record the concat
    and metadata files they were handed, then materialize the output file.
    """

    def __init__(self, durations_ms, fail_ffmpeg=False):
        self.durations_ms = dict(durations_ms)
        self.fail_ffmpeg = fail_ffmpeg
        self.concat_text = None
        self.metadata_text = None
        self.ffmpeg_args = None

    def __call__(self, name, args, timeout=300, *, cancel_check=None):
        if name == "ffprobe":
            page = int(Path(args[-1]).stem.split("-")[1])
            return f"{self.durations_ms[page] / 1000:.6f}\n"
        assert name == "ffmpeg"
        self.ffmpeg_args = args
        list_index = args.index("-i") + 1
        meta_index = args.index("-i", list_index + 1) + 1
        self.concat_text = Path(args[list_index]).read_text(encoding="utf-8")
        self.metadata_text = Path(args[meta_index]).read_text(encoding="utf-8")
        if self.fail_ffmpeg:
            raise ValueError("Media processing failed. simulated encoder crash")
        Path(args[-1]).write_bytes(b"fake m4b audio")
        return ""


class AudiobookExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        previous = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = self.temp.name
        self.previous_data_dir = previous
        exports._jobs.clear()
        self.app = FastAPI()
        self.app.include_router(audiobook_routes.router, prefix="/api/books")
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        exports._jobs.clear()
        if self.previous_data_dir is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.previous_data_dir
        self.temp.cleanup()

    def prepare_book(self, pages=2):
        book = library.import_pdf(b"%PDF fixture", "A Book")
        profile = library.profile_id("Aria", "en")
        for page in range(1, pages + 1):
            library.save_page(book["id"], page, f"Page {page} text", pages)
            audio_dir = library.book_dir(book["id"]) / "audio" / profile
            audio_dir.mkdir(parents=True, exist_ok=True)
            (audio_dir / f"page-{page}.wav").write_bytes(valid_wav_bytes())
            library.mark_page_audio(
                book["id"], profile, page, audio_dir / f"page-{page}.wav", [], 0.1, "Aria", "en"
            )
        return book["id"], profile

    def wait_for_status(self, job_id, statuses, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = exports._jobs.get(job_id)
            if job and job.get("status") in statuses:
                return job
            time.sleep(0.02)
        self.fail(f"Job {job_id} never reached {statuses}: {exports._jobs.get(job_id)}")

    def test_ffmetadata_chapters_and_concat_file_contents(self):
        book_id, profile = self.prepare_book(pages=3)
        fake = FakeMediaTools({1: 1500, 2: 2500, 3: 4000})
        with patch.object(media_tools, "run_media_tool", side_effect=fake):
            created = self.client.post(
                f"/api/books/{book_id}/audiobooks", json={"profileId": profile}
            )
            self.assertEqual(created.status_code, 201)
            payload = created.json()
            self.assertEqual(payload["status"], "QUEUED")
            self.assertEqual(payload["pageCount"], 3)
            job = self.wait_for_status(payload["jobId"], {"COMPLETED", "FAILED"})
        self.assertEqual(job["status"], "COMPLETED")

        lines = fake.concat_text.strip().splitlines()
        self.assertEqual(lines[0], "ffconcat version 1.0")
        expected_pages = [
            library.page_audio_path(book_id, profile, page).resolve().as_posix().replace("'", "'\\''")
            for page in (1, 2, 3)
        ]
        self.assertEqual(lines[1:], [f"file '{path}'" for path in expected_pages])

        meta_lines = fake.metadata_text.strip().splitlines()
        self.assertEqual(meta_lines[0], ";FFMETADATA1")
        self.assertEqual(meta_lines[1], "title=A Book")
        self.assertEqual(meta_lines[2], "artist=BookVoice")
        self.assertEqual(meta_lines[3], "album=A Book")
        chapters = [meta_lines[index : index + 5] for index in range(4, len(meta_lines), 5)]
        self.assertEqual(len(chapters), 3)
        cursor = 0
        for index, chapter in enumerate(chapters, start=1):
            self.assertEqual(chapter[0], "[CHAPTER]")
            self.assertEqual(chapter[1], "TIMEBASE=1/1000")
            self.assertEqual(int(chapter[2].split("=")[1]), cursor)
            cursor += {1: 1500, 2: 2500, 3: 4000}[index]
            self.assertEqual(int(chapter[3].split("=")[1]), cursor)
            self.assertEqual(chapter[4], f"title=Page {index}")

        ffmpeg_args = [str(arg) for arg in fake.ffmpeg_args]
        self.assertEqual(ffmpeg_args[:4], ["-f", "concat", "-safe", "0"])
        self.assertEqual(
            ffmpeg_args[-8:],
            ["-map_metadata", "1", "-c:a", "aac", "-b:a", "96k", "-vn", ffmpeg_args[-1]],
        )
        export_dir = library.book_dir(book_id) / "exports"
        self.assertEqual([p.name for p in export_dir.iterdir()], [f"{payload['jobId'][:12]}.m4b"])

    def test_concat_path_escaping_survives_quotes(self):
        quoted = exports._quote_concat_path("C:/books/it's here/page-1.wav")
        self.assertEqual(quoted, "'C:/books/it'\\''s here/page-1.wav'")
        backslashed = exports._quote_concat_path(r"C:\books\page-1.wav")
        self.assertEqual(backslashed, "'C:/books/page-1.wav'")

    def test_job_lifecycle_reports_progress_and_download_url(self):
        book_id, profile = self.prepare_book(pages=2)
        gate = threading.Event()
        probe_calls = []

        def slow_probe(name, args, timeout=300, cancel_check=None):
            if name == "ffprobe":
                probe_calls.append(args[-1])
                if len(probe_calls) >= 2:
                    gate.wait(timeout=5)
                return "1.000000\n"
            Path(args[-1]).write_bytes(b"fake m4b audio")
            return ""

        with patch.object(media_tools, "run_media_tool", side_effect=slow_probe):
            created = self.client.post(
                f"/api/books/{book_id}/audiobooks", json={"profileId": profile}
            )
            job_id = created.json()["jobId"]
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                status = self.client.get(
                    f"/api/books/{book_id}/audiobooks/{job_id}"
                ).json()
                if status["pagesDone"] >= 1:
                    break
                time.sleep(0.01)
            self.assertGreaterEqual(status["pagesDone"], 1)
            self.assertNotIn("downloadUrl", status)
            gate.set()
            final = self.wait_for_status(job_id, {"COMPLETED", "FAILED"})
        self.assertEqual(final["status"], "COMPLETED")
        served = self.client.get(f"/api/books/{book_id}/audiobooks/{job_id}").json()
        self.assertEqual(
            served["downloadUrl"], f"/api/books/{book_id}/audiobooks/{job_id}/content"
        )

    def test_failed_status_when_ffmpeg_fails_and_temp_files_are_cleaned(self):
        book_id, profile = self.prepare_book(pages=1)
        with patch.object(
            media_tools,
            "run_media_tool",
            side_effect=FakeMediaTools({1: 1000}, fail_ffmpeg=True),
        ):
            created = self.client.post(
                f"/api/books/{book_id}/audiobooks", json={"profileId": profile}
            )
            job_id = created.json()["jobId"]
            job = self.wait_for_status(job_id, {"FAILED"})
        self.assertEqual(job["status"], "FAILED")
        self.assertIn("simulated encoder crash", job["error"])
        export_dir = library.book_dir(book_id) / "exports"
        if export_dir.is_dir():
            self.assertEqual(list(export_dir.iterdir()), [])

    def test_unknown_book_returns_404(self):
        response = self.client.post(
            "/api/books/" + "a" * 64 + "/audiobooks", json={"profileId": "x"}
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"]["code"], "BOOK_NOT_FOUND")

    def test_malformed_profile_is_mapped_to_404(self):
        book_id, _ = self.prepare_book(pages=1)
        response = self.client.post(
            f"/api/books/{book_id}/audiobooks", json={"profileId": "short"}
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"]["code"], "BOOK_NOT_FOUND")

    def test_no_prepared_audio_is_rejected_with_409(self):
        book = library.import_pdf(b"%PDF fixture", "Silent Book")
        library.save_page(book["id"], 1, "Page one", 1)
        profile = library.profile_id("Aria", "en")
        response = self.client.post(
            f"/api/books/{book['id']}/audiobooks", json={"profileId": profile}
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "AUDIOBOOK_REJECTED")

    def test_unknown_job_and_cross_book_access_are_404(self):
        book_id, profile = self.prepare_book(pages=1)
        missing = self.client.get(f"/api/books/{book_id}/audiobooks/deadbeef")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["detail"]["code"], "AUDIOBOOK_NOT_FOUND")

        other = library.import_pdf(b"%PDF fixture", "Other Book")
        response = self.client.get(f"/api/books/{other['id']}/audiobooks/deadbeef")
        self.assertEqual(response.status_code, 404)

    def test_delete_removes_finished_job_and_output_file(self):
        book_id, profile = self.prepare_book(pages=1)
        with patch.object(
            media_tools, "run_media_tool", side_effect=FakeMediaTools({1: 1000})
        ):
            created = self.client.post(
                f"/api/books/{book_id}/audiobooks", json={"profileId": profile}
            )
            job_id = created.json()["jobId"]
            job = self.wait_for_status(job_id, {"COMPLETED", "FAILED"})
        output = Path(job["outputPath"])
        self.assertTrue(output.is_file())
        deleted = self.client.delete(f"/api/books/{book_id}/audiobooks/{job_id}")
        self.assertEqual(deleted.status_code, 204)
        self.assertFalse(output.exists())
        gone = self.client.get(f"/api/books/{book_id}/audiobooks/{job_id}")
        self.assertEqual(gone.status_code, 404)

    def test_cancel_requests_stop_a_running_job(self):
        book_id, profile = self.prepare_book(pages=2)
        release = threading.Event()
        probe_calls = []

        def blocking_probe(name, args, timeout=300, cancel_check=None):
            if name == "ffprobe":
                probe_calls.append(args[-1])
                if len(probe_calls) >= 2:
                    if not release.wait(timeout=5):
                        raise media_tools.MediaToolCancelled("ffprobe was cancelled.")
                    if cancel_check and cancel_check():
                        raise media_tools.MediaToolCancelled("ffprobe was cancelled.")
                return "1.000000\n"
            Path(args[-1]).write_bytes(b"fake m4b audio")
            return ""

        with patch.object(media_tools, "run_media_tool", side_effect=blocking_probe):
            created = self.client.post(
                f"/api/books/{book_id}/audiobooks", json={"profileId": profile}
            )
            job_id = created.json()["jobId"]
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if exports._jobs[job_id]["pagesDone"] >= 1:
                    break
                time.sleep(0.01)
            cancelled = self.client.delete(
                f"/api/books/{book_id}/audiobooks/{job_id}"
            )
            self.assertEqual(cancelled.status_code, 204)
            release.set()
            job = self.wait_for_status(job_id, {"CANCELLED"})
        self.assertEqual(job["status"], "CANCELLED")

    def test_one_shot_download_deletes_record_and_file(self):
        book_id, profile = self.prepare_book(pages=1)
        with patch.object(
            media_tools, "run_media_tool", side_effect=FakeMediaTools({1: 1200})
        ):
            created = self.client.post(
                f"/api/books/{book_id}/audiobooks", json={"profileId": profile}
            )
            job_id = created.json()["jobId"]
            job = self.wait_for_status(job_id, {"COMPLETED", "FAILED"})
        output = Path(job["outputPath"])

        downloaded = self.client.get(
            f"/api/books/{book_id}/audiobooks/{job_id}/content"
        )
        self.assertEqual(downloaded.status_code, 200)
        self.assertEqual(downloaded.headers["content-type"].split(";")[0], "audio/mp4")
        self.assertTrue(downloaded.headers["content-disposition"].startswith("attachment"))
        self.assertIn(".m4b", downloaded.headers["content-disposition"])
        self.assertEqual(downloaded.content, b"fake m4b audio")
        self.assertFalse(output.exists())
        gone = self.client.get(f"/api/books/{book_id}/audiobooks/{job_id}")
        self.assertEqual(gone.status_code, 404)

    def test_download_before_completion_is_404(self):
        book_id, profile = self.prepare_book(pages=1)
        response = self.client.get(
            f"/api/books/{book_id}/audiobooks/deadbeef/content"
        )
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
