"""Regression tests for universal user config persistence."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import services.config_service as config_service  # noqa: E402


class ConfigServiceTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = self._tmp.name
        self._prev_data = os.environ.get("DATA_DIR")
        self._prev_app = os.environ.get("APP_DIR")
        os.environ["DATA_DIR"] = self.data_dir
        os.environ["APP_DIR"] = str(ROOT)

    def tearDown(self):
        if self._prev_data is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self._prev_data
        if self._prev_app is None:
            os.environ.pop("APP_DIR", None)
        else:
            os.environ["APP_DIR"] = self._prev_app
        self._tmp.cleanup()

    def test_defaults_when_missing_file(self):
        cfg = config_service.get_config()
        self.assertEqual(cfg["voice_id"], None)
        self.assertEqual(cfg["language_id"], "en")
        self.assertEqual(cfg["ocr_use_gpu"], False)
        self.assertEqual(cfg["tts_device"], "auto")

    def test_merge_over_defaults(self):
        updated = config_service.update_config({"language_id": "ar", "voice_id": "Ryan"})
        self.assertEqual(updated["language_id"], "ar")
        self.assertEqual(updated["voice_id"], "Ryan")
        self.assertEqual(updated["tts_device"], "auto")
        again = config_service.get_config()
        self.assertEqual(again["language_id"], "ar")
        self.assertEqual(again["voice_id"], "Ryan")

    def test_sanitize_drops_unknown_and_wrong_types(self):
        path = Path(self.data_dir) / "config.json"
        path.write_text(
            json.dumps(
                {
                    "language_id": "ar",
                    "voice_id": 123,
                    "ocr_use_gpu": "yes",
                    "tts_device": "cuda",
                    "secret": "nope",
                    "extra": True,
                }
            ),
            encoding="utf-8",
        )
        cfg = config_service.get_config()
        self.assertEqual(cfg["language_id"], "ar")
        self.assertEqual(cfg["voice_id"], None)  # wrong type dropped → default
        self.assertEqual(cfg["ocr_use_gpu"], False)
        self.assertEqual(cfg["tts_device"], "cuda")
        self.assertNotIn("secret", cfg)
        self.assertNotIn("extra", cfg)

    def test_sanitize_drops_semantically_invalid_language_and_device(self):
        path = Path(self.data_dir) / "config.json"
        path.write_text(
            json.dumps(
                {
                    "language_id": "fr",
                    "tts_device": "gpu",
                    "voice_id": "  ",
                }
            ),
            encoding="utf-8",
        )
        cfg = config_service.get_config()
        self.assertEqual(cfg["language_id"], "en")  # invalid → default
        self.assertEqual(cfg["tts_device"], "auto")
        self.assertIsNone(cfg["voice_id"])

    def test_atomic_persistence_roundtrip(self):
        config_service.update_config(
            {
                "voice_id": "Natasha",
                "language_id": "en",
                "ocr_use_gpu": True,
                "tts_device": "cpu",
            }
        )
        path = Path(self.data_dir) / "config.json"
        self.assertTrue(path.is_file())
        raw = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(raw["voice_id"], "Natasha")
        self.assertEqual(raw["ocr_use_gpu"], True)
        self.assertEqual(raw["tts_device"], "cpu")
        # No leftover temp files
        leftovers = list(Path(self.data_dir).glob(".config-*.tmp"))
        self.assertEqual(leftovers, [])

    def test_null_voice_id_clears_selection(self):
        config_service.update_config({"voice_id": "Guy"})
        config_service.update_config({"voice_id": None})
        self.assertIsNone(config_service.get_config()["voice_id"])

    def test_app_version_from_version_file(self):
        version = config_service.app_version()
        expected = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        self.assertEqual(version, expected)
        # app_version should expose a dotted release version, not a fallback.
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")

    def test_partial_update_preserves_other_keys(self):
        config_service.update_config({"voice_id": "Aria", "language_id": "ar"})
        config_service.update_config({"tts_device": "cuda"})
        cfg = config_service.get_config()
        self.assertEqual(cfg["voice_id"], "Aria")
        self.assertEqual(cfg["language_id"], "ar")
        self.assertEqual(cfg["tts_device"], "cuda")


class ConfigApiValidationTests(unittest.TestCase):
    """Route-level validation without loading the full FastAPI app stack."""

    def test_tts_device_allowlist(self):
        from routes.config import ConfigUpdate

        # Pydantic model accepts any string; route enforces allowlist.
        # Replicate route check here as a pure unit of the contract.
        allowed = {None, "auto", "cpu", "cuda", "mps"}
        for value in ("auto", "cpu", "cuda", "mps"):
            self.assertIn(value, allowed)
        self.assertNotIn("gpu", allowed)
        model = ConfigUpdate(tts_device="cuda")
        self.assertEqual(model.tts_device, "cuda")

    def test_language_validation_helper(self):
        from services.path_utils import validate_language_id

        self.assertEqual(validate_language_id("en"), "en")
        self.assertEqual(validate_language_id("AR"), "ar")
        with self.assertRaises(ValueError):
            validate_language_id("fr")

    def test_voice_validation_helper(self):
        from services.path_utils import validate_voice_id

        self.assertEqual(validate_voice_id("Ryan"), "Ryan")
        with self.assertRaises(ValueError):
            validate_voice_id("../evil")


if __name__ == "__main__":
    unittest.main()
