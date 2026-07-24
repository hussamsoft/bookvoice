from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
import wave
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from services import voice_profile_service as profiles  # noqa: E402


def voice_wav(seconds: float = 6.0, rate: int = 24_000) -> bytes:
    payload = io.BytesIO()
    with wave.open(payload, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        frames = int(seconds * rate)
        pattern = b"\x00\x20\x00\xe0"
        output.writeframes(pattern * (frames // 2))
    return payload.getvalue()


class VoiceProfileServiceTests(unittest.TestCase):
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

    def test_profile_creation_requires_consent_and_writes_quality_metadata(self):
        source = Path(self.temp.name) / "sample.wav"
        source.write_bytes(voice_wav())

        with self.assertRaisesRegex(ValueError, "permission"):
            profiles.create_profile(source, "Interview Voice", consent_confirmed=False)

        created = profiles.create_profile(
            source,
            "Interview Voice",
            consent_confirmed=True,
            source_info={"kind": "VIDEO", "fileName": "interview.mp4"},
        )

        self.assertEqual(created["id"], "interview_voice")
        self.assertEqual(created["sourceType"], "VIDEO")
        self.assertAlmostEqual(created["quality"]["durationSec"], 6.0, places=1)
        self.assertTrue((profiles.voices_dir() / "interview_voice.wav").is_file())
        metadata = json.loads(
            (profiles.voices_dir() / "interview_voice.json").read_text(encoding="utf-8")
        )
        self.assertTrue(metadata["consentConfirmed"])
        self.assertNotIn(str(source), json.dumps(metadata))

    def test_legacy_wav_is_listed_without_requiring_a_sidecar(self):
        path = profiles.voices_dir() / "legacy_voice.wav"
        path.write_bytes(voice_wav())

        listed = profiles.list_profiles()

        self.assertEqual(listed[0]["id"], "legacy_voice")
        self.assertTrue(listed[0]["isLegacy"])

    def test_delete_removes_reference_metadata_and_condition_caches(self):
        source = Path(self.temp.name) / "sample.wav"
        source.write_bytes(voice_wav())
        created = profiles.create_profile(source, "Delete Me", consent_confirmed=True)
        (profiles.voices_dir() / f'{created["id"]}.en.deadbeef.conds.pt').write_bytes(b"cache")

        profiles.delete_profile(created["id"])

        self.assertFalse(any(profiles.voices_dir().glob(f'{created["id"]}*')))


if __name__ == "__main__":
    unittest.main()
