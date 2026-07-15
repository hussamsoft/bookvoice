"""TTS status/reload lifecycle tests — never load the real model or CUDA."""
from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


def _import_tts():
    """Import tts_service with torch stubbed if unavailable."""
    try:
        import services.tts_service as tts  # noqa: WPS433
        return tts
    except ImportError:
        # Minimal torch stub so the module can import in bare environments.
        torch = MagicMock()
        torch.cuda.is_available.return_value = False
        torch.backends.mps = MagicMock()
        torch.backends.mps.is_available.return_value = False
        sys.modules.setdefault("torch", torch)
        sys.modules.setdefault("torchaudio", MagicMock())
        import services.tts_service as tts  # noqa: WPS433
        return tts


class TtsLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tts = _import_tts()
        # Reset module globals between tests.
        self.tts._model = None
        self.tts._model_type = None
        self.tts._model_state.clear()
        self.tts._model_state.update(
            {
                "status": "idle",
                "detail": "",
                "device": "unknown",
                "cuda": False,
                "loading_started": None,
            }
        )

    def test_state_snapshot_hides_loading_started_and_reports_elapsed(self):
        self.tts._model_state["status"] = "loading"
        self.tts._model_state["detail"] = "Loading…"
        self.tts._model_state["loading_started"] = time.time() - 12
        snap = self.tts.state_snapshot()
        self.assertNotIn("loading_started", snap)
        self.assertEqual(snap["status"], "loading")
        self.assertIn("elapsed_s", snap)
        self.assertGreaterEqual(snap["elapsed_s"], 11)

    def test_state_snapshot_no_elapsed_when_ready(self):
        self.tts._model_state["status"] = "ready"
        self.tts._model_state["loading_started"] = None
        snap = self.tts.state_snapshot()
        self.assertNotIn("elapsed_s", snap)
        self.assertNotIn("loading_started", snap)

    def test_request_reload_from_error_to_loading(self):
        self.tts._model_state["status"] = "error"
        self.tts._model_state["detail"] = "boom"
        with patch.object(self.tts, "submit_tts") as submit:
            snap = self.tts.request_reload("en")
        self.assertEqual(snap["status"], "loading")
        self.assertIn("eload", snap["detail"].lower())
        submit.assert_called_once()
        args, _kwargs = submit.call_args
        self.assertEqual(args[0], self.tts.TtsPriority.INTERACTIVE)
        self.assertEqual(args[1], self.tts.preload_model)
        self.assertEqual(args[2], "en")

    def test_request_reload_from_idle(self):
        self.tts._model_state["status"] = "idle"
        with patch.object(self.tts, "submit_tts") as submit:
            snap = self.tts.request_reload("en")
        self.assertEqual(snap["status"], "loading")
        submit.assert_called_once()

    def test_repeated_reload_while_loading_does_not_queue_duplicate(self):
        self.tts._model_state["status"] = "loading"
        self.tts._model_state["detail"] = "already"
        self.tts._model_state["loading_started"] = time.time()
        with patch.object(self.tts, "submit_tts") as submit:
            snap = self.tts.request_reload("en")
        self.assertEqual(snap["status"], "loading")
        submit.assert_not_called()

    def test_reload_while_ready_does_not_queue(self):
        self.tts._model_state["status"] = "ready"
        with patch.object(self.tts, "submit_tts") as submit:
            snap = self.tts.request_reload("en")
        self.assertEqual(snap["status"], "ready")
        submit.assert_not_called()

    def test_preload_failure_sets_stable_public_error(self):
        def boom(_lang):
            raise RuntimeError("CUDA OOM")

        with patch.object(self.tts, "get_model", side_effect=boom):
            with patch.object(self.tts, "maybe_cleanup_sessions"):
                self.tts.preload_model("en")
        snap = self.tts.state_snapshot()
        self.assertEqual(snap["status"], "error")
        self.assertIn("CUDA OOM", snap["detail"])
        self.assertNotIn("loading_started", snap)

    def test_session_cleanup_completes_without_synthesis_state(self):
        """Cleanup is independent from narration locals and returns nothing."""
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            sessions_dir.mkdir()
            with patch.object(
                self.tts,
                "_data_dirs",
                return_value=(temp_dir, str(Path(temp_dir) / "voices"), str(sessions_dir)),
            ):
                result = self.tts.maybe_cleanup_sessions(force=True)

        self.assertIsNone(result)

    def test_narrate_failure_does_not_stick_on_generating(self):
        model = MagicMock()
        model.device = "cpu"
        model.sr = 24000
        self.tts._model_state["status"] = "ready"
        self.tts._model_state["detail"] = "Model ready on CPU."

        with patch.object(self.tts, "get_model", return_value=model):
            with patch.object(self.tts, "maybe_cleanup_sessions"):
                with patch.object(self.tts, "_split_into_chunks", return_value=["hi"]):
                    with patch.object(
                        self.tts, "_generate_chunk", side_effect=RuntimeError("boom")
                    ):
                        with self.assertRaises(RuntimeError):
                            self.tts.narrate_text("hi", "session1", 0)

        snap = self.tts.state_snapshot()
        self.assertEqual(snap["status"], "ready")
        self.assertNotEqual(snap["status"], "generating")
        self.assertIn("failed", snap["detail"].lower())

    def test_narrate_returns_segment_timings(self):
        import torch

        model = MagicMock()
        model.device = "cpu"
        model.sr = 24000
        # 0.5s of silence per chunk at 24kHz
        fake = torch.zeros(1, 12000)

        with patch.object(self.tts, "get_model", return_value=model):
            with patch.object(self.tts, "maybe_cleanup_sessions"):
                with patch.object(
                    self.tts, "_split_into_chunks", return_value=["Hello.", "World."]
                ):
                    with patch.object(self.tts, "_generate_chunk", return_value=fake):
                        with patch.object(self.tts.ta, "save"):
                            with patch.object(self.tts, "_data_dirs", return_value=("d", "v", "s")):
                                with patch("os.makedirs"):
                                    result = self.tts.narrate_text(
                                        "Hello. World.", "session1", 0
                                    )

        self.assertIsInstance(result, dict)
        self.assertIn("audio_url", result)
        self.assertEqual(len(result["segments"]), 2)
        self.assertAlmostEqual(result["segments"][0]["start_s"], 0.0)
        self.assertAlmostEqual(result["segments"][0]["end_s"], 0.5)
        self.assertAlmostEqual(result["segments"][1]["start_s"], 0.5)
        self.assertAlmostEqual(result["duration_s"], 1.0)

    def test_audio_filename_changes_with_voice_language_and_text(self):
        base = self.tts._audio_filename(2, "hello", "voice-a", "en", None)
        other_voice = self.tts._audio_filename(2, "hello", "voice-b", "en", None)
        other_language = self.tts._audio_filename(2, "hello", "voice-a", "ar", None)
        other_text = self.tts._audio_filename(2, "goodbye", "voice-a", "en", None)

        self.assertEqual(base, self.tts._audio_filename(2, "hello", "voice-a", "en", None))
        self.assertEqual(len({base, other_voice, other_language, other_text}), 4)
        self.assertTrue(base.startswith("page_2_"))
        self.assertTrue(base.endswith(".wav"))

    def test_bump_generation_aborts_in_flight_chunks(self):
        """A generation-token bump mid-synthesis cancels remaining chunks."""
        import torch

        model = MagicMock()
        model.device = "cpu"
        model.sr = 24000
        fake = torch.zeros(1, 12000)

        call_count = {"n": 0}

        def slow_generate(_model, _chunk, _lang, **_kw):
            call_count["n"] += 1
            # After the first chunk, bump the generation token to simulate a
            # page change / voice switch superseding this synthesis.
            if call_count["n"] == 1:
                self.tts.bump_generation()
            return fake

        self.tts._model_state["status"] = "ready"
        with patch.object(self.tts, "get_model", return_value=model):
            with patch.object(self.tts, "maybe_cleanup_sessions"):
                with patch.object(
                    self.tts,
                    "_split_into_chunks",
                    return_value=["one.", "two.", "three.", "four."],
                ):
                    with patch.object(self.tts, "_generate_chunk", side_effect=slow_generate):
                        with patch.object(self.tts.ta, "save"):
                            with patch.object(self.tts, "_data_dirs", return_value=("d", "v", "s")):
                                with patch("os.makedirs"):
                                    with self.assertRaises(self.tts.GenerationCancelled):
                                        self.tts.narrate_text(
                                            "one. two. three. four.", "session1", 0
                                        )

        # Only the first chunk should have generated; the token bump is detected
        # at the start of chunk 1's iteration, before _generate_chunk is called.
        self.assertEqual(call_count["n"], 1)
        # The model should be back to ready (cancellation is not a failure).
        snap = self.tts.state_snapshot()
        self.assertEqual(snap["status"], "ready")
        self.assertNotIn("failed", snap["detail"].lower())

    def test_bump_generation_returns_monotonic_tokens(self):
        first = self.tts.bump_generation()
        second = self.tts.bump_generation()
        self.assertGreater(second, first)

    def test_streaming_yields_chunks_then_done(self):
        """narrate_text_streaming emits one chunk event per chunk, then done."""
        import torch

        model = MagicMock()
        model.device = "cpu"
        model.sr = 24000
        fake = torch.zeros(1, 12000)  # 0.5s per chunk

        with patch.object(self.tts, "get_model", return_value=model):
            with patch.object(self.tts, "maybe_cleanup_sessions"):
                with patch.object(
                    self.tts,
                    "_split_into_chunks",
                    return_value=["one.", "two.", "three."],
                ):
                    with patch.object(self.tts, "_generate_chunk", return_value=fake):
                        with patch.object(self.tts.ta, "save"):
                            with patch.object(
                                self.tts, "_data_dirs", return_value=("d", "v", "s")
                            ):
                                with patch("os.makedirs"):
                                    events = list(
                                        self.tts.narrate_text_streaming(
                                            "one. two. three.", "session1", 0
                                        )
                                    )

        # 3 chunk events + 1 done event
        chunk_events = [e for e in events if e["type"] == "chunk"]
        done_events = [e for e in events if e["type"] == "done"]
        self.assertEqual(len(chunk_events), 3)
        self.assertEqual(len(done_events), 1)
        # Chunks are indexed 0..2 with cumulative start_s offsets
        self.assertEqual(chunk_events[0]["index"], 0)
        self.assertAlmostEqual(chunk_events[0]["start_s"], 0.0)
        self.assertAlmostEqual(chunk_events[0]["end_s"], 0.5)
        self.assertEqual(chunk_events[1]["index"], 1)
        self.assertAlmostEqual(chunk_events[1]["start_s"], 0.5)
        self.assertEqual(chunk_events[2]["index"], 2)
        self.assertAlmostEqual(chunk_events[2]["start_s"], 1.0)
        # Done event carries the full-page metadata
        self.assertIn("audio_url", done_events[0])
        self.assertAlmostEqual(done_events[0]["duration_s"], 1.5)
        self.assertEqual(len(done_events[0]["segments"]), 3)

    def test_streaming_respects_generation_cancellation(self):
        """A mid-stream bump_generation aborts remaining chunks."""
        import torch

        model = MagicMock()
        model.device = "cpu"
        model.sr = 24000
        fake = torch.zeros(1, 12000)
        count = {"n": 0}

        def slow(_m, _c, _l, **_k):
            count["n"] += 1
            if count["n"] == 1:
                self.tts.bump_generation()
            return fake

        with patch.object(self.tts, "get_model", return_value=model):
            with patch.object(self.tts, "maybe_cleanup_sessions"):
                with patch.object(
                    self.tts, "_split_into_chunks", return_value=["a.", "b.", "c."]
                ):
                    with patch.object(self.tts, "_generate_chunk", side_effect=slow):
                        with patch.object(self.tts.ta, "save"):
                            with patch.object(
                                self.tts, "_data_dirs", return_value=("d", "v", "s")
                            ):
                                with patch("os.makedirs"):
                                    with self.assertRaises(self.tts.GenerationCancelled):
                                        list(
                                            self.tts.narrate_text_streaming(
                                                "a. b. c.", "session1", 0
                                            )
                                        )

        self.assertEqual(count["n"], 1)

    def test_pronunciation_cache_reuses_a_deterministic_clip(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions = Path(temp_dir) / "sessions"
            voices = Path(temp_dir) / "voices"
            voices.mkdir()

            def synthesize(text, session_id, filename, voice_id, language_id):
                target = sessions / session_id / filename
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"wav")
                return {"audio_url": f"/sessions/{session_id}/{filename}"}

            with patch.object(
                self.tts, "_data_dirs", return_value=(temp_dir, str(voices), str(sessions))
            ):
                with patch.object(self.tts, "_synthesize_audio", side_effect=synthesize) as generate:
                    first = self.tts.pronounce_text("hello", "session1", None, "en")
                    second = self.tts.pronounce_text("hello", "session2", None, "en")

        self.assertEqual(first["audio_url"], second["audio_url"])
        generate.assert_called_once()

    def test_export_cached_pages_concatenates_latest_full_page_audio(self):
        """Export uses one canonical full-page WAV per requested page, never chunks."""
        import torch

        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            session_dir = sessions_dir / "session1"
            session_dir.mkdir(parents=True)
            # Page 1 has two revisions; the newest full-page file must win.
            old = session_dir / "page_1_aaaaaaaaaaaaaaaa.wav"
            latest = session_dir / "page_1_bbbbbbbbbbbbbbbb.wav"
            page_two = session_dir / "page_2_cccccccccccccccc.wav"
            chunk = session_dir / "page_2_c0_cccccccccccccccc.wav"
            for path in (old, latest, page_two, chunk):
                path.touch()
            os.utime(old, (1, 1))
            os.utime(latest, (2, 2))

            fake_wav = torch.zeros(1, 120)
            with patch.object(
                self.tts,
                "_data_dirs",
                return_value=(temp_dir, str(Path(temp_dir) / "voices"), str(sessions_dir)),
            ):
                with patch.object(self.tts.ta, "load", return_value=(fake_wav, 24000)) as load:
                    with patch.object(self.tts.ta, "save") as save:
                        result = self.tts.export_cached_pages("session1", 1, 2)

        self.assertEqual(load.call_count, 2)
        self.assertEqual(load.call_args_list[0].args[0], str(latest))
        self.assertEqual(load.call_args_list[1].args[0], str(page_two))
        self.assertTrue(result["audio_url"].startswith("/sessions/session1/export_1-2_"))
        self.assertEqual(result["pages"], [1, 2])
        save.assert_called_once()


class TtsStreamRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_pronounce_does_not_use_full_page_book_cache(self):
        import routes.tts as tts_routes

        request = tts_routes.PronounceRequest(
            text="word", session_id="session1", language_id="en"
        )
        future = Future()
        future.set_result({
            "audio_url": "/sessions/session1/word.wav",
            "segments": [],
            "duration_s": 0.1,
            "word_timings": [],
        })

        with patch.object(tts_routes, "submit_tts", return_value=future):
            with patch.object(tts_routes, "_cache_completed_page") as cache_page:
                response = await tts_routes.pronounce(request)

        self.assertEqual(response.audio_url, "/sessions/session1/word.wav")
        cache_page.assert_not_called()

    async def test_full_page_narration_promotes_completed_audio(self):
        import routes.tts as tts_routes

        request = tts_routes.NarrateRequest(
            text="Page text", session_id="session1", page_index=1,
            language_id="en", book_id="a" * 64,
        )
        result = {
            "audio_url": "/sessions/session1/page.wav",
            "segments": [],
            "duration_s": 0.2,
            "word_timings": [],
        }
        future = Future()
        future.set_result(result)

        with patch.object(tts_routes, "submit_tts", return_value=future):
            with patch.object(tts_routes, "_cache_completed_page") as cache_page:
                await tts_routes.narrate(request)

        cache_page.assert_called_once_with(request, "Page text", 1, result)

    async def test_progressive_narration_uses_priority_tts_worker(self):
        """Streaming synthesis must stay on the serialized priority worker."""
        import routes.tts as tts_routes

        request = tts_routes.NarrateRequest(
            text="Hello world.",
            session_id="session1",
            page_index=0,
            language_id="en",
            priority="current",
        )
        scheduled_priorities = []
        executor = ThreadPoolExecutor(max_workers=1)

        def submit(priority, fn, *args, **kwargs):
            scheduled_priorities.append(priority)
            return executor.submit(fn, *args, **kwargs)

        events = iter(
            [
                {
                    "type": "done",
                    "audio_url": "/sessions/session1/page.wav",
                    "segments": [],
                    "duration_s": 1.0,
                    "word_timings": [],
                }
            ]
        )
        try:
            with patch.object(tts_routes, "submit_tts", side_effect=submit):
                with patch.object(tts_routes, "narrate_text_streaming", return_value=events):
                    response = await tts_routes.narrate_stream(request)
                    body = []
                    async for chunk in response.body_iterator:
                        body.append(chunk)
        finally:
            executor.shutdown(wait=True)

        self.assertEqual(scheduled_priorities, [tts_routes.TtsPriority.CURRENT])
        self.assertIn('"type": "done"', "".join(body))


class KillStaleServersTests(unittest.TestCase):
    """Mocked process-tree handling for launch.kill_stale_servers."""

    def setUp(self):
        ROOT_LAUNCH = ROOT
        if str(ROOT_LAUNCH) not in sys.path:
            sys.path.insert(0, str(ROOT_LAUNCH))
        import launch  # noqa: WPS433

        self.launch = launch

    def test_terminates_parent_and_descendants(self):
        psutil = MagicMock()
        parent = MagicMock()
        parent.pid = 100
        parent.info = {
            "pid": 100,
            "name": "python.exe",
            "exe": r"C:\Users\u\AppData\Local\BookVoice\.venv\Scripts\python.exe",
            "cmdline": [
                r"C:\Users\u\AppData\Local\BookVoice\.venv\Scripts\python.exe",
                "-m",
                "uvicorn",
                "main:app",
            ],
        }
        child = MagicMock()
        child.pid = 101
        parent.children.return_value = [child]
        gone = [parent, child]
        alive = []
        psutil.process_iter.return_value = [parent]
        psutil.wait_procs.return_value = (gone, alive)
        psutil.NoSuchProcess = type("NoSuchProcess", (Exception,), {})
        psutil.AccessDenied = type("AccessDenied", (Exception,), {})

        log = MagicMock()
        runtime = r"C:\Users\u\AppData\Local\BookVoice"

        with patch.object(self.launch, "psutil", psutil):
            with patch.object(self.launch.time, "sleep"):
                self.launch.kill_stale_servers(r"C:\BookVoice\App", runtime, log)

        parent.terminate.assert_called_once()
        child.terminate.assert_called_once()

    def test_terminates_packaged_worker_server(self):
        psutil = MagicMock()
        parent = MagicMock()
        parent.pid = 200
        parent.info = {
            "pid": 200,
            "name": "python.exe",
            "exe": r"C:\BookVoice\App\runtime\worker\python.exe",
            "cmdline": [
                r"C:\BookVoice\App\runtime\worker\python.exe",
                "-m",
                "uvicorn",
                "main:app",
            ],
        }
        parent.children.return_value = []
        psutil.process_iter.return_value = [parent]
        psutil.wait_procs.return_value = ([parent], [])
        psutil.NoSuchProcess = type("NoSuchProcess", (Exception,), {})
        psutil.AccessDenied = type("AccessDenied", (Exception,), {})

        with patch.object(self.launch, "psutil", psutil):
            with patch.object(self.launch.time, "sleep"):
                self.launch.kill_stale_servers(
                    r"C:\BookVoice\App",
                    r"C:\Users\u\AppData\Local\BookVoice",
                    MagicMock(),
                )

        parent.terminate.assert_called_once()

    def test_missing_process_is_ignored(self):
        psutil = MagicMock()
        psutil.NoSuchProcess = type("NoSuchProcess", (Exception,), {})
        psutil.AccessDenied = type("AccessDenied", (Exception,), {})
        bad = MagicMock()
        bad.info = {
            "pid": 1,
            "name": "python.exe",
            "exe": r"C:\x\BookVoice\.venv\Scripts\python.exe",
            "cmdline": ["python", "-m", "uvicorn", "main:app"],
        }

        def raise_missing(*_a, **_k):
            raise psutil.NoSuchProcess()

        bad.terminate.side_effect = raise_missing
        bad.children.side_effect = raise_missing
        psutil.process_iter.return_value = [bad]
        log = MagicMock()
        with patch.object(self.launch, "psutil", psutil):
            with patch.object(self.launch.time, "sleep"):
                self.launch.kill_stale_servers(r"C:\BookVoice\App", r"C:\x\BookVoice", log)

    def test_access_denied_is_ignored(self):
        psutil = MagicMock()
        psutil.NoSuchProcess = type("NoSuchProcess", (Exception,), {})
        psutil.AccessDenied = type("AccessDenied", (Exception,), {})
        bad = MagicMock()
        bad.info = {
            "pid": 2,
            "name": "python.exe",
            "exe": r"C:\x\BookVoice\.venv\Scripts\python.exe",
            "cmdline": ["python", "-m", "uvicorn", "main:app"],
        }
        bad.children.side_effect = psutil.AccessDenied()
        bad.terminate.side_effect = psutil.AccessDenied()
        psutil.process_iter.return_value = [bad]
        log = MagicMock()
        with patch.object(self.launch, "psutil", psutil):
            with patch.object(self.launch.time, "sleep"):
                self.launch.kill_stale_servers(r"C:\BookVoice\App", r"C:\x\BookVoice", log)

    def test_unrelated_python_not_killed(self):
        psutil = MagicMock()
        psutil.NoSuchProcess = type("NoSuchProcess", (Exception,), {})
        psutil.AccessDenied = type("AccessDenied", (Exception,), {})
        other = MagicMock()
        other.info = {
            "pid": 9,
            "name": "python.exe",
            "exe": r"C:\other\.venv\Scripts\python.exe",
            "cmdline": ["python", "-m", "uvicorn", "other:app", "--port", "8000"],
        }
        psutil.process_iter.return_value = [other]
        log = MagicMock()
        with patch.object(self.launch, "psutil", psutil):
            with patch.object(self.launch.time, "sleep"):
                self.launch.kill_stale_servers(
                    r"C:\BookVoice\App",
                    r"C:\Users\u\AppData\Local\BookVoice",
                    log,
                )
        other.terminate.assert_not_called()


class LauncherReadinessTests(unittest.TestCase):
    def test_backend_is_ready_opens_as_soon_as_health_is_ready(self):
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import launch  # noqa: WPS433

        health = MagicMock()
        health.status = 200
        health.__enter__.return_value = health
        with patch.object(launch.urllib.request, "urlopen", return_value=health) as urlopen:
            self.assertTrue(launch.backend_is_ready("http://127.0.0.1:8000"))

        self.assertEqual(
            urlopen.call_args_list,
            [
                (("http://127.0.0.1:8000/api/health",), {"timeout": 1}),
            ],
        )

    def test_backend_is_ready_does_not_query_a_loading_tts_model(self):
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import launch  # noqa: WPS433

        health = MagicMock(status=200)
        health.__enter__.return_value = health
        with patch.object(launch.urllib.request, "urlopen", return_value=health) as urlopen:
            self.assertTrue(launch.backend_is_ready("http://127.0.0.1:8000"))
        self.assertEqual(urlopen.call_count, 1)

    def test_backend_is_ready_rejects_a_connection_error(self):
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import launch  # noqa: WPS433

        with patch.object(launch.urllib.request, "urlopen", side_effect=OSError("not ready")):
            self.assertFalse(launch.backend_is_ready("http://127.0.0.1:8000"))

    def test_launcher_accepts_a_prepared_book_path(self):
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import launch  # noqa: WPS433

        args = launch.parse_args([r"C:\Books\sample.bookvoice"])
        self.assertEqual(args.book_path, r"C:\Books\sample.bookvoice")


class LauncherRuntimeTests(unittest.TestCase):
    def setUp(self):
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import launch as launch_module  # noqa: WPS433

        self.launch = launch_module

    def test_install_id_is_stable_for_same_app_dir_and_version(self):
        app_dir = r"C:\Program Files\BookVoice"
        first = self.launch.install_id(app_dir, "1.10.0")
        second = self.launch.install_id(app_dir, "1.10.0")
        self.assertEqual(first, second)
        self.assertEqual(len(first), 12)

    def test_install_id_changes_with_version(self):
        app_dir = r"C:\Program Files\BookVoice"
        self.assertNotEqual(
            self.launch.install_id(app_dir, "1.9.0"),
            self.launch.install_id(app_dir, "1.10.0"),
        )

    def test_resolve_runtime_dir_uses_scoped_install_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app_dir = os.path.join(temp_dir, "App")
            os.makedirs(app_dir)
            with open(os.path.join(app_dir, "VERSION"), "w", encoding="utf-8") as handle:
                handle.write("1.10.0\n")
            with patch.dict(os.environ, {"BOOKVOICE_PORTABLE": ""}, clear=False):
                runtime = self.launch.resolve_runtime_dir(app_dir)
        self.assertIn(os.path.join("BookVoice", "installs"), runtime.replace("/", "\\"))

    def test_resolve_runtime_dir_honors_portable_flag(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.dict(os.environ, {"BOOKVOICE_PORTABLE": "1"}, clear=False):
                runtime = self.launch.resolve_runtime_dir(temp_dir)
        expected = os.path.join(temp_dir, ".bookvoice")
        self.assertEqual(os.path.normcase(runtime), os.path.normcase(expected))

    def test_bundled_python_points_at_runtime_python(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            embed_dir = os.path.join(temp_dir, "runtime", "python")
            os.makedirs(embed_dir)
            exe = os.path.join(embed_dir, "python.exe")
            open(exe, "wb").close()
            resolved = self.launch.bundled_python(temp_dir)
        self.assertEqual(resolved, exe)


if __name__ == "__main__":
    unittest.main()
