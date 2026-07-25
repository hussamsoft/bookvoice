"""Speech-to-speech conversion tests — never load the real model or CUDA."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

def _import_tts():
    """Import tts_service with torch stubbed if unavailable."""
    try:
        import services.tts_service as module  # noqa: WPS433
        return module
    except ImportError:
        torch = MagicMock()
        torch.cuda.is_available.return_value = False
        torch.backends.mps = MagicMock()
        torch.backends.mps.is_available.return_value = False
        sys.modules.setdefault("torch", torch)
        sys.modules.setdefault("torchaudio", MagicMock())
        import services.tts_service as module  # noqa: WPS433
        return module


tts = _import_tts()


def tone(seconds: float, rate: int = 16_000, amplitude: float = 0.4) -> np.ndarray:
    t = np.arange(int(seconds * rate), dtype=np.float32) / rate
    return (amplitude * np.sin(2 * np.pi * 180.0 * t)).astype(np.float32)


def silence(seconds: float, rate: int = 16_000) -> np.ndarray:
    return np.zeros(int(seconds * rate), dtype=np.float32)


class SpeechWindowTests(unittest.TestCase):
    def test_windows_are_cut_at_pauses_rather_than_mid_word(self):
        audio = np.concatenate([tone(2.0), silence(1.0), tone(2.0)])

        windows = tts._speech_windows(audio, 16_000)

        self.assertEqual(len(windows), 2)
        first_end = windows[0][1] / 16_000
        second_start = windows[1][0] / 16_000
        self.assertGreater(second_start, first_end)
        # The pause itself is excluded from both windows.
        self.assertLess(first_end, 2.3)
        self.assertGreater(second_start, 2.7)

    def test_long_uninterrupted_speech_is_split_under_the_window_cap(self):
        audio = tone(70.0)

        windows = tts._speech_windows(audio, 16_000)

        self.assertGreater(len(windows), 1)
        for start, end in windows:
            self.assertLessEqual((end - start) / 16_000, tts.VC_MAX_WINDOW_S + 0.5)

    def test_short_clicks_do_not_become_their_own_window(self):
        audio = np.concatenate([silence(0.5), tone(0.04), silence(0.5), tone(3.0)])

        windows = tts._speech_windows(audio, 16_000)

        self.assertEqual(len(windows), 1)
        self.assertGreater((windows[0][1] - windows[0][0]) / 16_000, 2.5)

    def test_fully_silent_audio_still_returns_a_single_window(self):
        self.assertEqual(tts._speech_windows(silence(1.0), 16_000), [(0, 16_000)])
        self.assertEqual(tts._speech_windows(np.zeros(0, dtype=np.float32), 16_000), [])


class VoiceConverterLoadingTests(unittest.TestCase):
    """Conversion needs only S3Gen, never the ~2 GB autoregressive T3 decoder."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        tts._vc_model = None
        tts._vc_source_s3gen = None
        tts._model = None
        # chatterbox is a heavy optional import; stub the module the loader
        # reaches for so this stays a pure unit test.
        self.vc_class = MagicMock(name="ChatterboxVC")
        module = types.ModuleType("chatterbox.vc")
        module.ChatterboxVC = self.vc_class
        self._previous = sys.modules.get("chatterbox.vc")
        sys.modules["chatterbox.vc"] = module

    def tearDown(self):
        if self._previous is None:
            sys.modules.pop("chatterbox.vc", None)
        else:
            sys.modules["chatterbox.vc"] = self._previous
        tts._vc_model = None
        tts._vc_source_s3gen = None
        tts._model = None
        self.temp.cleanup()

    def test_reuses_the_resident_narration_decoder_without_a_second_copy(self):
        narration = MagicMock()
        narration.s3gen = MagicMock(name="resident-s3gen")
        narration.device = "cpu"
        tts._model = narration
        converter = MagicMock()

        self.vc_class.side_effect = lambda *args, **kwargs: converter
        with patch.object(tts, "_local_model_path") as local_path:
            first = tts.get_voice_converter()
            second = tts.get_voice_converter()

        self.assertIs(first, converter)
        # Cached: the decoder is wrapped once, and no weights are loaded from disk.
        self.assertIs(second, converter)
        self.vc_class.assert_called_once_with(narration.s3gen, "cpu")
        local_path.assert_not_called()

    def test_loads_s3gen_alone_when_the_narration_model_is_not_resident(self):
        checkpoint = Path(self.temp.name)
        (checkpoint / "s3gen.safetensors").write_bytes(b"weights")
        # Deliberately absent: t3_cfg.safetensors, the model conversion never needs.
        converter = MagicMock()

        self.vc_class.from_local.return_value = converter
        with patch.object(tts, "_local_model_path", return_value=str(checkpoint)), \
                patch.object(tts, "_resolve_device", return_value="cpu"), \
                patch.object(tts, "get_model") as get_model:
            loaded = tts.get_voice_converter()

        self.assertIs(loaded, converter)
        self.vc_class.from_local.assert_called_once_with(str(checkpoint), "cpu")
        # The full narration stack is never touched.
        get_model.assert_not_called()

    def test_missing_conversion_weights_name_the_file_and_directory(self):
        with patch.object(tts, "_local_model_path", return_value=self.temp.name), \
                patch.object(tts, "_resolve_device", return_value="cpu"):
            with self.assertRaisesRegex(FileNotFoundError, "s3gen.safetensors"):
                tts.get_voice_converter()

    def test_a_standalone_decoder_is_released_once_the_full_model_loads(self):
        standalone = MagicMock(name="standalone")
        tts._vc_model = standalone
        tts._vc_source_s3gen = MagicMock(name="standalone-s3gen")

        narration = MagicMock()
        narration.s3gen = MagicMock(name="resident-s3gen")
        narration.device = "cpu"
        tts._model = narration
        replacement = MagicMock(name="wrapped-resident")

        self.vc_class.side_effect = lambda *args, **kwargs: replacement
        result = tts.get_voice_converter()

        self.assertIs(result, replacement)
        self.assertIs(tts._vc_model, replacement)


class ConvertVoiceAudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = self.temp.name
        self.source = Path(self.temp.name) / "source.wav"
        self.source.write_bytes(b"source-media")
        self.target = Path(self.temp.name) / "target.wav"
        self.target.write_bytes(b"target-voice")

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.previous
        self.temp.cleanup()

    def _converter(self, rendered_seconds: float = 1.0):
        import torch

        converter = MagicMock()
        converter.sr = 24_000
        converter.device = "cpu"
        converter.ref_dict = {"ref": 1}
        converter.watermarker = None
        converter.s3gen.tokenizer.return_value = ("tokens", None)
        converter.s3gen.inference.return_value = (
            torch.zeros(1, int(rendered_seconds * 24_000)),
            None,
        )
        return converter

    def _run(self, audio: np.ndarray, converter, **kwargs) -> dict:
        with patch.object(tts, "_decode_pcm_mono", return_value=audio), \
                patch.object(tts, "get_voice_converter", return_value=converter):
            return tts.convert_voice_audio(
                str(self.source),
                str(self.target),
                "studio-session",
                "converted.wav",
                **kwargs,
            )

    def test_conversion_preserves_the_pauses_between_converted_windows(self):
        audio = np.concatenate([tone(2.0), silence(1.0), tone(2.0)])
        converter = self._converter(rendered_seconds=2.0)

        result = self._run(audio, converter)

        self.assertEqual(converter.s3gen.inference.call_count, 2)
        converter.set_target_voice.assert_called_once_with(str(self.target))
        # Two 2s windows plus the ~1s pause carried over from the source.
        self.assertGreater(result["duration_s"], 4.5)
        self.assertLess(result["duration_s"], 5.6)
        self.assertEqual(result["windows"], 2)
        self.assertEqual(result["audio_url"], "/sessions/studio-session/converted.wav")

        written = Path(self.temp.name) / "sessions" / "studio-session" / "converted.wav"
        self.assertTrue(written.is_file())
        with wave.open(str(written), "rb") as handle:
            self.assertEqual(handle.getframerate(), 24_000)
            self.assertGreater(handle.getnframes(), 0)

    def test_conversion_reports_progress_for_every_window(self):
        audio = np.concatenate([tone(1.5), silence(0.8), tone(1.5), silence(0.8), tone(1.5)])
        seen: list[float] = []

        self._run(audio, self._converter(), progress=seen.append)

        self.assertEqual(len(seen), 3)
        self.assertAlmostEqual(seen[-1], 1.0)
        self.assertEqual(seen, sorted(seen))

    def test_conversion_stops_when_the_job_is_cancelled(self):
        audio = np.concatenate([tone(2.0), silence(1.0), tone(2.0)])
        cancellation = tts.GenerationCancellation()
        cancellation.cancel()

        with self.assertRaises(tts.GenerationCancelled):
            self._run(audio, self._converter(), cancel_event=cancellation)

    def test_conversion_requires_both_files_to_exist(self):
        with self.assertRaisesRegex(FileNotFoundError, "recording to convert"):
            tts.convert_voice_audio(
                str(Path(self.temp.name) / "missing.wav"),
                str(self.target),
                "studio-session",
                "converted.wav",
            )
        with self.assertRaisesRegex(FileNotFoundError, "target voice reference"):
            tts.convert_voice_audio(
                str(self.source),
                str(Path(self.temp.name) / "missing.wav"),
                "studio-session",
                "converted.wav",
            )

    def test_conversion_filenames_change_with_the_source_and_the_voice(self):
        with patch.object(tts, "_voice_reference_checksum", return_value="deadbeef"):
            first = tts.conversion_filename("source-a", "narrator")
            same = tts.conversion_filename("source-a", "narrator")
            other_source = tts.conversion_filename("source-b", "narrator")
            other_voice = tts.conversion_filename("source-a", "guest")

        self.assertEqual(first, same)
        self.assertNotEqual(first, other_source)
        self.assertNotEqual(first, other_voice)
        self.assertTrue(first.startswith("convert_"))
        self.assertTrue(first.endswith(".wav"))


if __name__ == "__main__":
    unittest.main()
