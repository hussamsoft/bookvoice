"""TTS status/reload lifecycle tests — never load the real model or CUDA."""
from __future__ import annotations

import sys
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
        with patch.object(self.tts.TTS_EXECUTOR, "submit") as submit:
            snap = self.tts.request_reload("en")
        self.assertEqual(snap["status"], "loading")
        self.assertIn("eload", snap["detail"].lower())
        submit.assert_called_once()
        args, _kwargs = submit.call_args
        self.assertEqual(args[0], self.tts.preload_model)
        self.assertEqual(args[1], "en")

    def test_request_reload_from_idle(self):
        self.tts._model_state["status"] = "idle"
        with patch.object(self.tts.TTS_EXECUTOR, "submit") as submit:
            snap = self.tts.request_reload("en")
        self.assertEqual(snap["status"], "loading")
        submit.assert_called_once()

    def test_repeated_reload_while_loading_does_not_queue_duplicate(self):
        self.tts._model_state["status"] = "loading"
        self.tts._model_state["detail"] = "already"
        self.tts._model_state["loading_started"] = time.time()
        with patch.object(self.tts.TTS_EXECUTOR, "submit") as submit:
            snap = self.tts.request_reload("en")
        self.assertEqual(snap["status"], "loading")
        submit.assert_not_called()

    def test_reload_while_ready_does_not_queue(self):
        self.tts._model_state["status"] = "ready"
        with patch.object(self.tts.TTS_EXECUTOR, "submit") as submit:
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
