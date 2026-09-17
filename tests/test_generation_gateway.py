"""Generation dispatch: local only after 2.8.0.

Audit finding C-37 removed the optional off-process executor hook
(``services.remote_execution``) because it was dormant — no
deployment registered an executor and ``run_remote_job`` had no
caller. A future hosted deployment that wants remote execution
should re-add the executor and dispatch path; this test file
covers only the local path that ships today.
"""
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
from services import tts_service  # noqa: E402


def _future(value):
    future = Future()
    future.set_result(value)
    return future


class LocalDispatchTests(unittest.TestCase):
    """The default dispatch: every kind goes to the tts_service priority queue."""

    def _payload(self, **overrides):
        payload = {
            "sessionId": "s1",
            "voiceId": None,
            "languageId": "en",
            "generationSettings": None,
        }
        payload.update(overrides)
        return payload

    def test_narrate_dispatches_through_priority_queue(self):
        with patch.object(tts_service, "submit_tts", return_value=_future({"ok": True})) as mock:
            payload = self._payload(text="hello", voiceId="v1")
            result = gateway.dispatch(gateway.NARRATE, payload)

        mock.assert_called_once()
        args, _ = mock.call_args
        # submit_tts(priority, fn, *args) — args[0]=priority, args[1]=fn,
        # args[2:]=positional args including the trailing cancellation.
        self.assertEqual(args[0], tts_service.TtsPriority.CURRENT)
        self.assertEqual(args[1], tts_service.narrate_studio_text)
        # text, sessionId, voiceId, languageId, generationSettings, cancellation
        self.assertEqual(args[2:], ("hello", "s1", "v1", "en", None, None))
        self.assertEqual(result, {"ok": True})

    def test_repair_dispatches_with_interactive_priority(self):
        with patch.object(tts_service, "submit_tts", return_value=_future({"ok": True})) as mock:
            payload = self._payload(text="fix this")
            gateway.dispatch(gateway.NARRATE_REPAIR, payload)

        args, _ = mock.call_args
        self.assertEqual(args[0], tts_service.TtsPriority.INTERACTIVE)
        self.assertEqual(args[1], tts_service.narrate_studio_repair_text)
        self.assertEqual(args[2:], ("fix this", "s1", None, "en", None, None))

    def test_convert_dispatches_to_convert_voice_audio(self):
        with patch.object(tts_service, "submit_tts", return_value=_future({"ok": True})) as mock:
            payload = self._payload(
                sourcePath="/data/source.wav",
                targetVoicePath="/data/target.wav",
                sessionId="sess-conv",
                voiceId="v1",
                filename="source.wav",
            )
            gateway.dispatch(gateway.CONVERT, payload)

        args, _ = mock.call_args
        self.assertEqual(args[0], tts_service.TtsPriority.CURRENT)
        self.assertEqual(args[1], tts_service.convert_voice_audio)
        self.assertEqual(args[2], "/data/source.wav")
        self.assertEqual(args[3], "/data/target.wav")

    def test_unknown_kind_raises(self):
        with self.assertRaises(ValueError):
            gateway.dispatch("not_a_real_kind", self._payload())


if __name__ == "__main__":
    unittest.main()
