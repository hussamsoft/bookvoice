"""Regression test for the audiobook-export prune-on-read fix (C-27).

Before the fix, _prune_runtime_records() was only called inside
create_audiobook_export(). get_audiobook_job() is the polling endpoint
that the frontend hits frequently, and did NOT trigger prune. A
long-running server with many completed exports and no downloads
accumulated _jobs entries forever.

After the fix, get_audiobook_job() calls _prune_runtime_records()
before reading, bounding the dict as much as create does.
"""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


class AudiobookExportPruneOnReadTests(unittest.TestCase):
    def test_get_audiobook_job_prunes_stale_records(self):
        from services import audiobook_export_service as exports

        # Snapshot the TTL so we can shrink it for the test.
        original_ttl = exports.RUNTIME_RECORD_TTL_SECONDS
        exports.RUNTIME_RECORD_TTL_SECONDS = 0.05  # 50 ms

        try:
            # Seed the in-memory job registry with a couple of fake
            # completed-and-old jobs.
            exports._jobs.clear()
            now = time.time()
            exports._jobs["old-job-1"] = {
                "id": "old-job-1",
                "bookId": "book-1",
                "status": "COMPLETED",
                "endedAt": now - 1000,  # very old
                "pagesDone": 5,
                "pageCount": 5,
                "pages": [1, 2, 3, 4, 5],
                "outputPath": None,
            }
            exports._jobs["old-job-2"] = {
                "id": "old-job-2",
                "bookId": "book-1",
                "status": "FAILED",
                "endedAt": now - 1000,
                "error": "test",
            }
            exports._jobs["old-job-3"] = {
                "id": "old-job-3",
                "bookId": "book-2",
                "status": "COMPLETED",
                "endedAt": now,  # fresh — should NOT be pruned
                "outputPath": None,
            }
            self.assertEqual(len(exports._jobs), 3)

            # A get call on a fresh job should still prune the old ones.
            try:
                exports.get_audiobook_job("book-2", "old-job-3")
            except Exception:
                # The job is fake; the prune runs first, so the job is
                # removed before the lookup — that is fine, the test
                # only cares that prune ran.
                pass

            # The fresh job should still be present; the old ones
            # should be gone.
            remaining = list(exports._jobs.keys())
            self.assertIn("old-job-3", remaining, "fresh job must survive prune")
            self.assertNotIn("old-job-1", remaining, "old completed job must be pruned")
            self.assertNotIn("old-job-2", remaining, "old failed job must be pruned")
        finally:
            exports.RUNTIME_RECORD_TTL_SECONDS = original_ttl
            exports._jobs.clear()


if __name__ == "__main__":
    unittest.main()
