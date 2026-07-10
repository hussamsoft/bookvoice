from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import build


class ReleaseManifestTests(unittest.TestCase):
    def test_tree_fingerprint_is_stable_and_content_sensitive(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "a.txt").write_text("alpha", encoding="utf-8")
            (root / "nested").mkdir()
            (root / "nested" / "b.txt").write_text("beta", encoding="utf-8")

            first = build.tree_fingerprint(root)
            second = build.tree_fingerprint(root)
            (root / "a.txt").write_text("changed", encoding="utf-8")
            changed = build.tree_fingerprint(root)

        self.assertEqual(first, second)
        self.assertNotEqual(first, changed)

    def test_write_release_manifest_records_source_and_static_hashes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "source"
            static = root / "static"
            source.mkdir()
            static.mkdir()
            (source / "app.py").write_text("print('ok')", encoding="utf-8")
            (static / "index.html").write_text("<html></html>", encoding="utf-8")
            target = root / "release-manifest.json"
            expected_source = build.tree_fingerprint(source)
            expected_static = build.tree_fingerprint(static)

            build.write_release_manifest(target, "1.8.0", source, static)
            payload = json.loads(target.read_text(encoding="utf-8"))

        self.assertEqual(payload["version"], "1.8.0")
        self.assertEqual(payload["source_sha256"], expected_source)
        self.assertEqual(payload["static_sha256"], expected_static)


if __name__ == "__main__":
    unittest.main()
