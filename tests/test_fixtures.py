"""Validate generated test fixtures and the offline benchmark path."""
from __future__ import annotations

import json
import sys
import unittest
import unittest.mock
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"


class FixtureValidityTests(unittest.TestCase):
    def test_fixture_corpus_exists(self):
        expected = [
            "english.pdf", "arabic.pdf", "two-column.pdf",
            "punctuation.pdf", "repeated-words.pdf",
            "timing_en.wav", "timing_en.json",
            "timing_ar.wav", "timing_ar.json",
        ]
        for name in expected:
            self.assertTrue((FIXTURES / name).is_file(), f"missing fixture: {name}")

    def test_pdfs_are_valid_pdf_structure(self):
        for name in ("english.pdf", "arabic.pdf", "two-column.pdf", "punctuation.pdf"):
            data = (FIXTURES / name).read_bytes()
            self.assertTrue(data.startswith(b"%PDF-"), f"{name} is not a PDF")
            self.assertIn(b"%%EOF", data, f"{name} missing EOF marker")

    def test_timing_wavs_load_with_documented_rate(self):
        for name in ("timing_en.wav", "timing_ar.wav"):
            with wave.open(str(FIXTURES / name), "rb") as wf:
                self.assertEqual(wf.getnchannels(), 1)
                self.assertEqual(wf.getsampwidth(), 2)
                self.assertGreater(wf.getframerate(), 0)

    def test_timing_manifest_matches_wav_duration(self):
        manifest_path = FIXTURES / "timing_en.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        with wave.open(str(FIXTURES / "timing_en.wav"), "rb") as wf:
            duration_s = wf.getnframes() / wf.getframerate()
        last_end = max(w["end_s"] for w in manifest["words"])
        # WAV should be at least as long as the last word end (silence padding may extend it).
        self.assertLessEqual(last_end, duration_s + 0.01)

    def test_timing_manifest_words_are_monotonic(self):
        for name in ("timing_en.json", "timing_ar.json"):
            manifest = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
            starts = [w["start_s"] for w in manifest["words"]]
            self.assertEqual(starts, sorted(starts), f"{name} word starts are not monotonic")


class BenchmarkOfflineTests(unittest.TestCase):
    def test_offline_benchmark_runs_and_writes_json(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import benchmark  # noqa: WPS433

        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            with unittest.mock.patch.object(benchmark, "BASELINE", Path(tmp) / "perf.json"):
                payload = benchmark.run_benchmark(real=False)

        self.assertEqual(payload["mode"], "mock")
        self.assertIn("full_page_mock", payload["phases"])
        self.assertIn("elapsed_s", payload["phases"]["full_page_mock"])
        self.assertIn("captured_at", payload)


if __name__ == "__main__":
    unittest.main()
