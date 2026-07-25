"""Generation dispatch: local by default, remote when a deployment registers one."""
from __future__ import annotations

import sys
import unittest
from concurrent.futures import Future
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from services import generation_gateway as gateway  # noqa: E402
from services import remote_execution  # noqa: E402


def _future(value):
    future = Future()
    future.set_result(value)
    return future


class LocalDispatchTests(unittest.TestCase):
    """With no executor registered the desktop path must be untouched."""

    def tearDown(self):
        remote_execution.set_executor(None)

    def test_no_executor_is_registered_by_default(self):
        self.assertFalse(remote_execution.is_remote())
        self.assertIsNone(remote_execution.executor())

    def test_narration_goes_through_the_priority_queue_as_current(self):
        with patch("services.tts_service.submit_tts", return_value=_future({"ok": 1})) as submit:
            result = gateway.narrate("studio-x", "Hello.", "en", "narrator", {"seed": 3})

        self.assertEqual(result, {"ok": 1})
        args = submit.call_args.args
        self.assertEqual(args[0].name, "CURRENT")
        self.assertEqual(args[2], "Hello.")
        self.assertEqual(args[3], "studio-x")
        self.assertEqual(args[4], "narrator")
        self.assertEqual(args[5], "en")

    def test_repair_keeps_its_interactive_priority(self):
        with patch("services.tts_service.submit_tts", return_value=_future({"ok": 2})) as submit:
            gateway.narrate_repair("studio-x", "Fixed.", "en", "narrator", {})

        self.assertEqual(submit.call_args.args[0].name, "INTERACTIVE")

    def test_conversion_passes_paths_and_the_progress_callback(self):
        seen = []

        def report(value):
            seen.append(value)

        with patch("services.tts_service.submit_tts", return_value=_future({"ok": 3})) as submit:
            gateway.convert(
                "studio-x", "/data/in.wav", "/data/voice.wav", "out.wav", progress=report
            )

        args = submit.call_args.args
        self.assertEqual(args[0].name, "CURRENT")
        self.assertEqual(args[2], "/data/in.wav")
        self.assertEqual(args[3], "/data/voice.wav")
        self.assertEqual(args[5], "out.wav")
        self.assertIs(submit.call_args.kwargs["progress"], report)

    def test_an_unknown_job_kind_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown generation job"):
            gateway.dispatch("teleport", {})


class RemoteDispatchTests(unittest.TestCase):
    def tearDown(self):
        remote_execution.set_executor(None)

    def test_a_registered_executor_replaces_local_generation_entirely(self):
        calls = []

        def executor(kind, payload, *, cancel_check=None, progress=None):
            calls.append((kind, payload))
            return {"audio_url": "/sessions/studio-x/out.wav"}

        remote_execution.set_executor(executor)
        with patch("services.tts_service.submit_tts") as submit:
            result = gateway.narrate("studio-x", "Hello.", "en", "narrator", {"seed": 1})

        submit.assert_not_called()
        self.assertEqual(result["audio_url"], "/sessions/studio-x/out.wav")
        kind, payload = calls[0]
        self.assertEqual(kind, gateway.NARRATE)
        # The payload must be plain data: it crosses a process boundary.
        self.assertEqual(payload["text"], "Hello.")
        self.assertEqual(payload["sessionId"], "studio-x")
        self.assertEqual(payload["voiceId"], "narrator")
        self.assertEqual(payload["generationSettings"], {"seed": 1})

    def test_cancellation_is_forwarded_so_a_remote_worker_can_be_stopped(self):
        received = {}

        def executor(kind, payload, *, cancel_check=None, progress=None):
            received["cancel_check"] = cancel_check
            return {}

        class Cancellation:
            def cancelled(self):
                return True

        remote_execution.set_executor(executor)
        gateway.narrate("studio-x", "Hi.", "en", None, {}, cancellation=Cancellation())

        self.assertTrue(received["cancel_check"]())

    def test_conversion_payload_carries_shared_storage_paths(self):
        received = {}

        def executor(kind, payload, *, cancel_check=None, progress=None):
            received.update(payload)
            return {}

        remote_execution.set_executor(executor)
        gateway.convert("studio-x", Path("/data/in.wav"), Path("/data/voice.wav"), "out.wav")

        self.assertEqual(received["sourcePath"], "/data/in.wav")
        self.assertEqual(received["targetVoicePath"], "/data/voice.wav")
        self.assertEqual(received["filename"], "out.wav")

    def test_the_worker_side_runs_jobs_locally_by_name(self):
        with patch("services.tts_service.submit_tts", return_value=_future({"ok": 9})) as submit:
            result = gateway.run_remote_job(
                gateway.CONVERT,
                {
                    "sourcePath": "/data/in.wav",
                    "targetVoicePath": "/data/voice.wav",
                    "sessionId": "studio-x",
                    "filename": "out.wav",
                },
            )

        self.assertEqual(result, {"ok": 9})
        submit.assert_called_once()

    def test_clearing_the_executor_restores_local_generation(self):
        remote_execution.set_executor(lambda *a, **k: {"remote": True})
        remote_execution.set_executor(None)

        with patch("services.tts_service.submit_tts", return_value=_future({"local": True})):
            self.assertEqual(gateway.narrate("studio-x", "Hi.", "en", None, {}), {"local": True})


if __name__ == "__main__":
    unittest.main()
