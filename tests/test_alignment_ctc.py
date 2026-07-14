"""CTC forced-alignment unit tests.

These run against the real torchaudio ``forced_align`` kernel with a synthetic
acoustic model, so the word-span math is exercised end to end without the
bundled 180 MB wav2vec2 weights.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

try:
    import torch
    import torchaudio  # noqa: F401

    HAVE_TORCH = True
except ImportError:  # pragma: no cover - torch is present on dev machines
    HAVE_TORCH = False

from services import alignment_service  # noqa: E402


VOCAB = {"<pad>": 0, "|": 1, "A": 2, "B": 3, "'": 4}
BLANK = 0
FRAME_SAMPLES = 320  # one 20 ms frame at 16 kHz, mirroring wav2vec2


class WordTokenTests(unittest.TestCase):
    def test_uppercases_and_keeps_vocab_characters(self) -> None:
        self.assertEqual(alignment_service._word_token_ids("ab", VOCAB), [2, 3])

    def test_folds_typographic_apostrophe_and_diacritics(self) -> None:
        self.assertEqual(alignment_service._word_token_ids("á’b", VOCAB), [2, 4, 3])

    def test_digits_and_symbols_produce_no_anchors(self) -> None:
        self.assertEqual(alignment_service._word_token_ids("42—", VOCAB), [])


class SegmentRangeTests(unittest.TestCase):
    def test_exact_chunk_cover_produces_per_chunk_ranges(self) -> None:
        words = ["ab", "a", "b", "ba"]
        segments = [
            {"text": "ab a", "start_s": 0.0, "end_s": 2.0},
            {"text": "b ba", "start_s": 2.0, "end_s": 4.5},
        ]
        ranges = alignment_service._segment_word_ranges(words, segments, 4.5)
        self.assertEqual(ranges, [(0, 2, 0.0, 2.0), (2, 4, 2.0, 4.5)])

    def test_mismatched_chunks_fall_back_to_whole_audio(self) -> None:
        words = ["ab", "a"]
        segments = [{"text": "different words", "start_s": 0.0, "end_s": 2.0}]
        ranges = alignment_service._segment_word_ranges(words, segments, 3.0)
        self.assertEqual(ranges, [(0, 2, 0.0, 3.0)])

    def test_missing_segments_fall_back_to_whole_audio(self) -> None:
        ranges = alignment_service._segment_word_ranges(["ab"], None, 1.5)
        self.assertEqual(ranges, [(0, 1, 0.0, 1.5)])


class FillUnanchoredTests(unittest.TestCase):
    def test_gap_between_anchors_is_distributed(self) -> None:
        spans = [(0.0, 1.0), None, None, (4.0, 5.0)]
        alignment_service._fill_unanchored(spans, 5.0)
        self.assertEqual(spans[1], (1.0, 2.5))
        self.assertEqual(spans[2], (2.5, 4.0))

    def test_leading_and_trailing_gaps_get_bounded_spans(self) -> None:
        spans = [None, (1.0, 2.0), None]
        alignment_service._fill_unanchored(spans, 3.0)
        self.assertEqual(spans[0], (0.0, 1.0))
        start, end = spans[2]
        self.assertGreaterEqual(start, 2.0)
        self.assertGreater(end, start)


@unittest.skipUnless(HAVE_TORCH, "torch/torchaudio required")
class CtcAlignTests(unittest.TestCase):
    """Drive _ctc_align with synthetic emissions through real forced_align."""

    def _fake_bundle(self, frame_tokens: list[int]):
        """Build a fake model whose emissions spell out frame_tokens."""
        logits = torch.full((1, len(frame_tokens), len(VOCAB)), -10.0)
        for frame, token in enumerate(frame_tokens):
            logits[0, frame, token] = 10.0

        class FakeModel:
            def parameters(self):
                return iter([torch.zeros(1)])

            def __call__(self, _x):
                return SimpleNamespace(logits=logits)

        return (FakeModel(), VOCAB, BLANK, "cpu")

    def _align(self, words_text: str, frame_tokens: list[int], segments=None):
        wave = torch.zeros(1, len(frame_tokens) * FRAME_SAMPLES)
        with (
            mock.patch.object(
                alignment_service, "_load_ctc", return_value=self._fake_bundle(frame_tokens)
            ),
            mock.patch("torchaudio.load", return_value=(wave, 16000)),
        ):
            return alignment_service._ctc_align(
                words_text.split(), "unused.wav", "en", segments
            )

    def test_words_receive_their_emission_spans(self) -> None:
        # Frames: A A _ B B _ | _ A A  → "ab a"
        frames = [2, 2, 0, 3, 3, 0, 1, 0, 2, 2]
        result = self._align("ab a", frames)
        self.assertIsNotNone(result)
        self.assertEqual([r["word"] for r in result], ["ab", "a"])

        frame_s = FRAME_SAMPLES / 16000  # 0.02
        first, second = result
        self.assertAlmostEqual(first["start_s"], 0.0, places=3)
        # Raw emission span ends at frame 5; 70% of the 3-frame silence gap
        # before the next word is granted to the tail.
        self.assertAlmostEqual(first["end_s"], 5 * frame_s + 0.7 * (3 * frame_s), places=3)
        self.assertAlmostEqual(second["start_s"], 8 * frame_s, places=3)
        self.assertAlmostEqual(second["end_s"], 10 * frame_s, places=3)

    def test_unanchorable_words_are_interpolated_between_neighbours(self) -> None:
        # "ab 42 a": the digits cannot anchor and must land between the others.
        frames = [2, 2, 0, 3, 3, 0, 1, 0, 2, 2]
        result = self._align("ab 42 a", frames)
        self.assertIsNotNone(result)
        self.assertEqual(len(result), 3)
        middle = result[1]
        self.assertGreaterEqual(middle["start_s"], result[0]["end_s"] - 1e-6)
        self.assertLessEqual(middle["end_s"], result[2]["start_s"] + 1e-6)

    def test_timings_are_monotonic_and_inside_the_audio(self) -> None:
        frames = [2, 0, 3, 0, 1, 2, 0, 3, 0, 1, 0, 2, 3, 0, 0]
        result = self._align("ab ab ab", frames)
        self.assertIsNotNone(result)
        duration = len(frames) * FRAME_SAMPLES / 16000
        prev_start = 0.0
        for item in result:
            self.assertGreaterEqual(item["start_s"], prev_start)
            self.assertGreater(item["end_s"], item["start_s"])
            self.assertLessEqual(item["start_s"], duration)
            prev_start = item["start_s"]

    def test_low_anchor_coverage_returns_none(self) -> None:
        frames = [2, 2, 0, 0]
        result = self._align("42 99 100 — ab", frames)
        self.assertIsNone(result)

    def test_segment_boundaries_offset_the_second_chunk(self) -> None:
        # One emission pass per chunk; both chunks say "A" over 4 frames.
        frames = [2, 2, 0, 0]
        seg_s = len(frames) * FRAME_SAMPLES / 16000  # 0.08
        segments = [
            {"text": "a", "start_s": 0.0, "end_s": seg_s},
            {"text": "a", "start_s": seg_s, "end_s": 2 * seg_s},
        ]
        wave = torch.zeros(1, int(2 * seg_s * 16000))
        with (
            mock.patch.object(
                alignment_service, "_load_ctc", return_value=self._fake_bundle(frames)
            ),
            mock.patch("torchaudio.load", return_value=(wave, 16000)),
        ):
            result = alignment_service._ctc_align(["a", "a"], "unused.wav", "en", segments)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result[0]["start_s"], 0.0, places=3)
        self.assertAlmostEqual(result[1]["start_s"], seg_s, places=3)
        self.assertGreater(result[1]["end_s"], seg_s)


@unittest.skipUnless(HAVE_TORCH, "torch/torchaudio required")
class AlignWordsTierTests(unittest.TestCase):
    def test_ctc_failure_marks_language_and_falls_back(self) -> None:
        with (
            mock.patch.object(alignment_service, "_ctc_available", return_value=True),
            mock.patch.object(
                alignment_service, "_ctc_align", side_effect=RuntimeError("boom")
            ),
            mock.patch.object(alignment_service, "_whisper_align", return_value=None),
            mock.patch.object(alignment_service.os.path, "isfile", return_value=True),
            mock.patch.object(alignment_service, "_ctc_failed", set()) as failed,
        ):
            result = alignment_service.align_words("hello world", "x.wav", "en")
        self.assertIsNone(result)
        self.assertIn("en", failed)


if __name__ == "__main__":
    unittest.main()
