from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from xml.etree import ElementTree as ET

import build
import build_msi

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


class MsiConfigTests(unittest.TestCase):
    def test_user_product_targets_local_app_data(self):
        product = build_msi.PRODUCTS["user"]
        self.assertEqual(product.install_scope, "perUser")
        self.assertEqual(product.parent_dir_id, "LocalAppDataFolder")
        self.assertEqual(product.install_dir_name, "App")
        self.assertTrue(product.desktop_shortcut)

    def test_machine_product_targets_program_files(self):
        product = build_msi.PRODUCTS["machine"]
        self.assertEqual(product.install_scope, "perMachine")
        self.assertEqual(product.parent_dir_id, "ProgramFilesFolder")

    def test_build_wxs_user_includes_local_app_data_folder(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dist = Path(temp_dir) / "dist"
            dist.mkdir()
            (dist / "main.py").write_text("print('ok')", encoding="utf-8")
            (dist / "bookvoice.ico").write_bytes(b"ico")
            original_dist = build_msi.DIST
            build_msi.DIST = dist
            try:
                wxs = build_msi.build_wxs([("main.py", dist / "main.py")], build_msi.PRODUCTS["user"])
                xml = ET.tostring(wxs, encoding="unicode")
            finally:
                build_msi.DIST = original_dist
        self.assertIn("LocalAppDataFolder", xml)
        self.assertIn('InstallScope="perUser"', xml)
        self.assertIn("DesktopShortcut", xml)


class EmbedPythonTests(unittest.TestCase):
    def _load_stage_embed(self):
        spec = importlib.util.spec_from_file_location(
            "stage_embed_python", ROOT / "scripts" / "stage_embed_python.py"
        )
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module

    def test_embed_cache_dir_is_versioned(self):
        module = self._load_stage_embed()
        cache = module.embed_cache_dir(ROOT)
        self.assertIn("python-3.10.11-embed-amd64", cache.as_posix())

    def test_embed_is_ready_requires_venv_module(self):
        module = self._load_stage_embed()
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = Path(temp_dir)
            (cache / "python.exe").write_bytes(b"")
            self.assertFalse(module.embed_is_ready(cache))
            venv_init = cache / "Lib" / "venv" / "__init__.py"
            ensure_init = cache / "Lib" / "ensurepip" / "__init__.py"
            nt_python = cache / "Lib" / "venv" / "scripts" / "nt" / "python.exe"
            venv_init.parent.mkdir(parents=True)
            ensure_init.parent.mkdir(parents=True)
            nt_python.parent.mkdir(parents=True)
            venv_init.write_text("", encoding="utf-8")
            ensure_init.write_text("", encoding="utf-8")
            self.assertFalse(module.embed_is_ready(cache))
            nt_python.write_bytes(b"")
            self.assertTrue(module.embed_is_ready(cache))

    def test_dist_includes_embed_python_with_venv_when_built(self):
        embed_exe = ROOT / "dist" / "runtime" / "python" / "python.exe"
        venv_init = ROOT / "dist" / "runtime" / "python" / "Lib" / "venv" / "__init__.py"
        nt_python = (
            ROOT / "dist" / "runtime" / "python" / "Lib" / "venv" / "scripts" / "nt" / "python.exe"
        )
        if not embed_exe.is_file():
            self.skipTest("dist/runtime/python not built yet — run python build.py")
        self.assertTrue(embed_exe.is_file())
        self.assertTrue(
            venv_init.is_file(),
            "bundled embed Python must include Lib/venv (embeddable zip omits it)",
        )
        self.assertTrue(
            nt_python.is_file(),
            "bundled embed Python must include Lib/venv/scripts/nt/python.exe",
        )


if __name__ == "__main__":
    unittest.main()
