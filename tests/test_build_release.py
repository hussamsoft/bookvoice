from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build

ROOT = Path(__file__).resolve().parent.parent


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

    def test_sync_large_tree_skips_identical_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "source"
            target = root / "target"
            source.mkdir()
            target.mkdir()
            (source / "model.bin").write_bytes(b"weights")
            (target / "model.bin").write_bytes(b"weights")
            source_stat = (source / "model.bin").stat()
            (target / "model.bin").touch()
            import os
            os.utime(target / "model.bin", (source_stat.st_atime, source_stat.st_mtime))

            with patch.object(build.shutil, "copy2") as copy:
                build.sync_large_tree(source, target)

        copy.assert_not_called()


class BundleBaselineTests(unittest.TestCase):
    def _load_measure_bundle(self):
        spec = importlib.util.spec_from_file_location(
            "measure_bundle", ROOT / "scripts" / "measure_bundle.py"
        )
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module

    def test_baseline_json_present_and_within_budget(self):
        """The committed bundle baseline must exist and stay under the budget."""
        baseline = ROOT / "tasks" / "bundle-baseline.json"
        self.assertTrue(baseline.is_file(), "tasks/bundle-baseline.json missing")
        payload = json.loads(baseline.read_text(encoding="utf-8"))
        self.assertLessEqual(
            payload["initial_entry_kib"],
            payload["budget_kib"],
            "initial entry exceeds the recorded budget",
        )


if __name__ == "__main__":
    unittest.main()
