"""Tests for path validation."""
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from services.path_utils import validate_page_index, MAX_PAGE_INDEX


class PathUtilsTests(unittest.TestCase):
    def test_page_index_within_limit(self):
        self.assertEqual(validate_page_index(0), 0)
        self.assertEqual(validate_page_index(9999), 9999)

    def test_page_index_rejects_overflow(self):
        with self.assertRaises(ValueError):
            validate_page_index(10000)
        with self.assertRaises(ValueError):
            validate_page_index(900000)


if __name__ == "__main__":
    unittest.main()
