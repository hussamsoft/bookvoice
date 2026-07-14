from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class DefaultVoiceTests(unittest.TestCase):
    def _load_module(self):
        script = ROOT / "scripts" / "ensure_default_voices.py"
        spec = importlib.util.spec_from_file_location("ensure_default_voices", script)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module

    def test_ensure_default_voices_creates_reference_clips(self):
        module = self._load_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "dist").mkdir()
            module.ensure_default_voices(root, min_voices=2)

            voices = sorted((root / "voices").glob("*.wav"))
            packaged = sorted((root / "dist" / "data" / "default_voices").glob("*.wav"))

        self.assertGreaterEqual(len(voices), 2)
        self.assertEqual(len(voices), len(packaged))

    def test_seed_default_voices_copies_missing_runtime_clips(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            defaults = root / "defaults"
            runtime = root / "runtime"
            defaults.mkdir()
            runtime.mkdir()
            (defaults / "Aria.wav").write_bytes(b"placeholder")

            os.environ["DATA_DIR"] = str(runtime)
            os.environ["DEFAULT_VOICES_DIR"] = str(defaults)
            sys.path.insert(0, str(ROOT / "backend"))
            try:
                from routes import voices as voices_route

                voices_route.seed_default_voices()
            finally:
                sys.path.pop(0)

            self.assertTrue((runtime / "voices" / "Aria.wav").is_file())


if __name__ == "__main__":
    unittest.main()
