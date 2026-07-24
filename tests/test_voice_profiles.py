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


def spoken_wav(
    syllables_per_sec: float,
    *,
    seconds: float = 6.0,
    rate: int = 24_000,
    loud: int = 9_000,
    quiet: int = 900,
) -> bytes:
    """Synthesize a clip whose loudness pulses at a known syllable rate."""
    payload = io.BytesIO()
    with wave.open(payload, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        period = max(2, int(rate / syllables_per_sec))
        frames = bytearray()
        for index in range(int(seconds * rate)):
            in_pulse = (index % period) < (period // 2)
            amplitude = loud if in_pulse else quiet
            sample = amplitude if (index % 2 == 0) else -amplitude
            frames += int(sample).to_bytes(2, "little", signed=True)
        output.writeframes(bytes(frames))
    return payload.getvalue()


class DerivedGenerationSettingsTests(unittest.TestCase):
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

    def test_a_faster_speaker_yields_a_faster_derived_pace(self):
        slow = Path(self.temp.name) / "slow.wav"
        fast = Path(self.temp.name) / "fast.wav"
        slow.write_bytes(spoken_wav(2.5))
        fast.write_bytes(spoken_wav(6.0))

        slow_settings = profiles.suggest_generation_settings(
            profiles.analyze_reference(slow)["speechMetrics"]
        )
        fast_settings = profiles.suggest_generation_settings(
            profiles.analyze_reference(fast)["speechMetrics"]
        )

        self.assertLess(slow_settings["pace"], fast_settings["pace"])
        self.assertLessEqual(slow_settings["pace"], 1.0)
        self.assertGreaterEqual(fast_settings["pace"], 1.0)

    def test_derived_settings_stay_inside_the_supported_control_range(self):
        for rate in (0.5, 3.0, 12.0):
            metrics = profiles.analyze_reference(
                self._write(f"rate-{rate}.wav", spoken_wav(rate))
            )["speechMetrics"]
            settings = profiles.suggest_generation_settings(metrics)
            self.assertGreaterEqual(settings["pace"], 0.85)
            self.assertLessEqual(settings["pace"], 1.15)
            self.assertGreaterEqual(settings["expression"], 0.2)
            self.assertLessEqual(settings["expression"], 0.8)
            self.assertIsNone(settings["seed"])

    def test_a_flat_recording_is_not_pushed_into_high_expression(self):
        flat = profiles.suggest_generation_settings(
            {"syllablesPerSec": 4.3, "dynamicsDb": 2.0}
        )
        lively = profiles.suggest_generation_settings(
            {"syllablesPerSec": 4.3, "dynamicsDb": 22.0}
        )

        self.assertLess(flat["expression"], lively["expression"])
        self.assertEqual(flat["temperature"], 0.7)
        self.assertEqual(lively["temperature"], 0.8)

    def test_silent_metrics_fall_back_to_the_neutral_defaults(self):
        settings = profiles.suggest_generation_settings({})
        self.assertEqual(settings["pace"], 1.0)
        self.assertEqual(settings["expression"], 0.2)

    def test_created_profiles_carry_settings_matched_to_the_recording(self):
        source = self._write("speaker.wav", spoken_wav(5.0))

        created = profiles.create_profile(source, "Matched Voice", consent_confirmed=True)

        self.assertIn("suggestedSettings", created)
        self.assertIn("speechMetrics", created["quality"])
        self.assertGreater(created["quality"]["speechMetrics"]["syllablesPerSec"], 0)
        listed = next(item for item in profiles.list_profiles() if item["id"] == "matched_voice")
        self.assertEqual(listed["suggestedSettings"], created["suggestedSettings"])

    def _write(self, name: str, payload: bytes) -> Path:
        path = Path(self.temp.name) / name
        path.write_bytes(payload)
        return path


if __name__ == "__main__":
    unittest.main()
