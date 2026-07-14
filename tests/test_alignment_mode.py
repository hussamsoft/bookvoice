from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from services import alignment_service  # noqa: E402
from services.alignment_service import alignment_mode  # noqa: E402


class AlignmentModeTests(unittest.TestCase):
    def setUp(self) -> None:
        # Ensure a clean env for each case.
        self._orig = os.environ.pop("DISABLE_FORCED_ALIGNMENT", None)

    def tearDown(self) -> None:
        os.environ.pop("DISABLE_FORCED_ALIGNMENT", None)
        if self._orig is not None:
            os.environ["DISABLE_FORCED_ALIGNMENT"] = self._orig

    def test_disabled_when_env_flag_set(self) -> None:
        for value in ("1", "true", "yes"):
            with self.subTest(value=value):
                os.environ["DISABLE_FORCED_ALIGNMENT"] = value
                self.assertEqual(alignment_mode(), "disabled")

    def test_estimate_when_no_aligner_is_available(self) -> None:
        with mock.patch.object(
            alignment_service.importlib.util, "find_spec", return_value=None
        ):
            self.assertEqual(alignment_mode(), "estimate")

    def test_whisper_when_package_importable_and_no_ctc_model(self) -> None:
        with (
            mock.patch.object(alignment_service, "_ctc_model_dir", return_value=None),
            mock.patch.object(
                alignment_service.importlib.util, "find_spec", return_value=mock.Mock()
            ),
        ):
            self.assertEqual(alignment_mode(), "whisper")

    def test_ctc_when_a_bundled_model_exists(self) -> None:
        with (
            mock.patch.object(
                alignment_service, "_ctc_model_dir", return_value="/models/alignment/en"
            ),
            mock.patch.object(
                alignment_service.importlib.util, "find_spec", return_value=mock.Mock()
            ),
        ):
            self.assertEqual(alignment_mode(), "ctc")

    def test_ctc_is_skipped_after_a_load_failure(self) -> None:
        with (
            mock.patch.object(
                alignment_service, "_ctc_model_dir", return_value="/models/alignment/en"
            ),
            mock.patch.object(
                alignment_service.importlib.util, "find_spec", return_value=mock.Mock()
            ),
            mock.patch.object(alignment_service, "_ctc_failed", {"en"}),
        ):
            self.assertEqual(alignment_mode(), "whisper")

    def test_disabled_flag_takes_precedence_over_all_tiers(self) -> None:
        os.environ["DISABLE_FORCED_ALIGNMENT"] = "true"
        with mock.patch.object(
            alignment_service.importlib.util, "find_spec", return_value=mock.Mock()
        ):
            self.assertEqual(alignment_mode(), "disabled")


if __name__ == "__main__":
    unittest.main()
