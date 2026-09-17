"""Regression test for the chapterCount bug (audit finding C-2).

book_library_service.py used to assign chapterCount = len(pages),
giving every EPUB/TXT import a wrong chapterCount equal to the page
count. This was fixed to chapterCount = len(chapters). This test
asserts the source no longer contains the regression and uses the
correct derivation.
"""
from __future__ import annotations

import inspect
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


class ChapterCountFieldTests(unittest.TestCase):
    def test_chapter_count_uses_chapter_count_not_page_count(self) -> None:
        """chapterCount must equal len(chapters), never len(pages)."""
        from services import book_library_service as library

        source = inspect.getsource(library)

        # Reject the regression: a literal "len(pages)" on the
        # manifest["chapterCount"] assignment line. The pre-fix code
        # wrote the page count into the chapter field.
        self.assertNotIn(
            'manifest["chapterCount"] = len(pages)',
            source,
            "C-2 regression: chapterCount = len(pages) writes page count "
            "into the chapterCount field.",
        )

        # Accept the fix: the chapter-count assignment uses the
        # chapters list from the extracted payload, not the pages.
        self.assertIn(
            'manifest["chapterCount"] = len(extracted.get("chapters") or [])',
            source,
            "expected chapterCount to be derived from extracted chapters, "
            "not from the page list.",
        )


if __name__ == "__main__":
    unittest.main()
