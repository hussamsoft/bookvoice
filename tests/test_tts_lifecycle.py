"""TTS status/reload lifecycle tests — never load the real model or CUDA."""
from __future__ import annotations

import sys
import tempfile
import time
import unittest
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
                self.launch.kill_stale_servers(runtime, log)

        parent.terminate.assert_called_once()
        child.terminate.assert_called_once()

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
                self.launch.kill_stale_servers(r"C:\x\BookVoice", log)

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
                self.launch.kill_stale_servers(r"C:\x\BookVoice", log)

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
                self.launch.kill_stale_servers(r"C:\Users\u\AppData\Local\BookVoice", log)
        other.terminate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
