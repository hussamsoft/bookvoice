from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from xml.etree import ElementTree as ET

import build
import build_msi

ROOT = Path(__file__).resolve().parent.parent


class ReleaseManifestTests(unittest.TestCase):
    def test_vite_production_environment_uses_same_origin_paths(self):
        production_env = ROOT / "frontend" / ".env.production"
        self.assertTrue(production_env.is_file(), "frontend/.env.production missing")
        values = {}
        for line in production_env.read_text(encoding="utf-8").splitlines():
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key] = value
        self.assertEqual(values.get("VITE_API_BASE_URL"), "/api")
        self.assertEqual(values.get("VITE_AUDIO_BASE_URL"), "")

    def test_fixed_loopback_urls_are_rejected_from_packaged_javascript(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            assets = Path(temp_dir)
            (assets / "good.js").write_text("fetch('/api/health')", encoding="utf-8")
            (assets / "bad.js").write_text(
                "fetch('http://localhost:8000/api/health')", encoding="utf-8"
            )
            self.assertEqual(build.fixed_loopback_assets(assets), ["bad.js"])

    def test_release_frontend_environment_uses_same_origin_api_paths(self):
        environment = build.release_frontend_environment(
            {
                "VITE_API_BASE_URL": "http://localhost:8000/api",
                "VITE_AUDIO_BASE_URL": "http://localhost:8000",
            }
        )

        self.assertEqual(environment["VITE_API_BASE_URL"], "/api")
        self.assertEqual(environment["VITE_AUDIO_BASE_URL"], "")

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


    def test_validate_rejects_missing_sticky_port_helper(self):
        required = [
            "main.py", "launch.py", "serve_bookvoice.py", "system_tray.py",
            "VERSION", "release-manifest.json", "requirements.txt",
            "BookVoice.bat", "Start-BookVoice-Server.bat",
            "scripts/kill_stale_bookvoice.ps1", "runtime/worker/python.exe",
            "runtime-manifest.json", "routes/tts.py", "routes/voices.py",
            "routes/config.py", "routes/studio.py", "services/tts_service.py",
            "services/config_service.py", "services/media_tools.py",
            "services/path_utils.py", "services/storage_utils.py",
            "services/studio_service.py", "services/voice_profile_service.py",
            "tools/ffmpeg/ffmpeg.exe", "tools/ffmpeg/ffprobe.exe",
            "tools/ffmpeg/NOTICE.txt", "tools/ffmpeg/LICENSE.txt",
            "static/index.html",
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            dist = root / "dist"
            backend = root / "backend"
            backend.mkdir()
            (backend / "main.py").write_text("placeholder", encoding="utf-8")
            for relative in required:
                path = dist / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("placeholder", encoding="utf-8")
            (dist / "data/default_voices").mkdir(parents=True)
            (dist / "data/default_voices/reference.wav").write_bytes(b"wav")
            original_dist, original_root, original_backend = build.DIST, build.ROOT, build.BACKEND
            build.DIST, build.ROOT, build.BACKEND = dist, root, backend
            try:
                with (
                    patch.object(build, "runtime_contract_errors", return_value=[]),
                    patch.object(build, "payload_import_errors", return_value=[]),
                ):
                    with self.assertRaises(SystemExit) as raised:
                        build.validate(skip_desktop=True)
            finally:
                build.DIST, build.ROOT, build.BACKEND = original_dist, original_root, original_backend
        self.assertIn("required missing: scripts/port_state.py", str(raised.exception))


    def test_payload_import_check_reports_missing_helper(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dist = Path(temp_dir)
            (dist / "runtime/worker").mkdir(parents=True)
            for module in ("serve_bookvoice", "launch", "main", "tunnel", "system_tray"):
                (dist / f"{module}.py").write_text("import port_state\n", encoding="utf-8")
            errors = build.payload_import_errors(dist, worker=Path(sys.executable))
        self.assertTrue(errors)
        self.assertIn("port_state", errors[0])

    def test_payload_import_check_accepts_bundled_helper(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dist = Path(temp_dir)
            (dist / "runtime/worker").mkdir(parents=True)
            (dist / "scripts").mkdir()
            (dist / "scripts/port_state.py").write_text("VALUE = 1\n", encoding="utf-8")
            for module in ("serve_bookvoice", "launch", "main", "tunnel", "system_tray"):
                (dist / f"{module}.py").write_text("import port_state\n", encoding="utf-8")
            errors = build.payload_import_errors(dist, worker=Path(sys.executable))
        self.assertEqual(errors, [])


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
    def test_collect_files_excludes_live_portable_studio_data_without_deleting_it(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dist = Path(temp_dir) / "dist"
            project_file = dist / ".bookvoice" / "data" / "studio" / "projects" / ("a" * 32) / "manifest.json"
            legacy_file = dist / "data" / "studio" / "projects" / ("b" * 32) / "manifest.json"
            app_file = dist / "main.py"
            project_file.parent.mkdir(parents=True)
            legacy_file.parent.mkdir(parents=True)
            project_file.write_text('{"name":"Portable"}', encoding="utf-8")
            legacy_file.write_text('{"name":"Legacy"}', encoding="utf-8")
            app_file.write_text("print('ok')", encoding="utf-8")
            original_dist = build_msi.DIST
            build_msi.DIST = dist
            try:
                files = build_msi.collect_files()
            finally:
                build_msi.DIST = original_dist
            self.assertEqual([relative for relative, _path in files], ["main.py"])
            self.assertTrue(project_file.is_file())
            self.assertTrue(legacy_file.is_file())

    def test_clear_cab_cache_removes_generated_cabinets_only(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            installer = Path(temp_dir)
            generated = installer / "cab_0_WixUIExtension.cab"
            payload = installer / "cab12.cab"
            retained = installer / "release-assets.json"
            generated.write_bytes(b"stale-ui-cache")
            payload.write_bytes(b"stale-payload")
            retained.write_text("{}", encoding="utf-8")
            original_out = build_msi.OUT
            build_msi.OUT = installer
            try:
                build_msi.clear_cab_cache()
            finally:
                build_msi.OUT = original_out
            self.assertFalse(generated.exists())
            self.assertFalse(payload.exists())
            self.assertTrue(retained.exists())

    def test_incremental_resume_flag_is_documented_by_the_cli(self):
        source = (ROOT / "build_msi.py").read_text(encoding="utf-8")
        self.assertIn('"--keep-cab-cache"', source)
        self.assertIn("No cabinet cache exists to reuse.", source)

    def test_release_asset_manifest_covers_both_msis_and_external_cabinets(self):
        spec = importlib.util.spec_from_file_location(
            "prepare_release_assets", ROOT / "scripts" / "prepare_release_assets.py"
        )
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp_dir:
            release_root = Path(temp_dir)
            installer = release_root / "installer"
            installer.mkdir()
            (release_root / "VERSION").write_text("2.1.1\n", encoding="utf-8")
            (installer / "BookVoice-User.msi").write_bytes(b"user-msi")
            (installer / "BookVoice.msi").write_bytes(b"machine-msi")
            (installer / "cab1.cab").write_bytes(b"cabinet-one")
            manifest = module.build_manifest(root=release_root, installer=installer)

        self.assertEqual(manifest["version"], "2.1.1")
        self.assertEqual(manifest["products"]["user"]["msi"], "BookVoice-User.msi")
        self.assertEqual(manifest["products"]["machine"]["msi"], "BookVoice.msi")
        self.assertGreater(len(manifest["products"]["user"]["cabinets"]), 0)
        self.assertTrue(all(asset["size"] < module.MAX_RELEASE_ASSET for asset in manifest["assets"].values()))

    def test_bootstrapper_is_pinned_to_the_release_version(self):
        spec = importlib.util.spec_from_file_location(
            "setup_bootstrapper", ROOT / "scripts" / "setup_bootstrapper.py"
        )
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)

        version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        self.assertEqual(module.RELEASE_VERSION, version)
        self.assertIn(f"/download/v{version}/", module.DEFAULT_MANIFEST_URL)

    def test_user_product_targets_local_app_data(self):
        product = build_msi.PRODUCTS["user"]
        self.assertEqual(product.install_scope, "perUser")
        self.assertEqual(product.parent_dir_id, "LocalAppDataFolder")
        self.assertEqual(product.install_dir_name, "App")
        self.assertTrue(product.desktop_shortcut)

    def test_machine_product_targets_program_files(self):
        product = build_msi.PRODUCTS["machine"]
        self.assertEqual(product.install_scope, "perMachine")
        self.assertEqual(product.parent_dir_id, "ProgramFiles64Folder")

    def test_build_wxs_user_includes_local_app_data_folder(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dist = Path(temp_dir) / "dist"
            dist.mkdir()
            (dist / "main.py").write_text("print('ok')", encoding="utf-8")
            (dist / "bookvoice.ico").write_bytes(b"ico")
            (dist / "desktop").mkdir()
            (dist / "desktop" / "BookVoice.exe").write_bytes(b"MZ")
            original_dist = build_msi.DIST
            build_msi.DIST = dist
            try:
                wxs = build_msi.build_wxs(
                    [("main.py", dist / "main.py"), ("desktop/BookVoice.exe", dist / "desktop" / "BookVoice.exe")],
                    build_msi.PRODUCTS["user"],
                )
                xml = ET.tostring(wxs, encoding="unicode")
            finally:
                build_msi.DIST = original_dist
        self.assertIn("LocalAppDataFolder", xml)
        self.assertIn('InstallScope="perUser"', xml)
        self.assertIn('Platform="x64"', xml)
        self.assertTrue(all(component.get("Win64") == "yes" for component in wxs.iter("Component")))
        self.assertIn("DesktopShortcut", xml)
        self.assertIn("Software\\Classes\\.bookvoice", xml)
        self.assertIn("BookVoice.PreparedBook", xml)
        self.assertIn('&quot;[INSTALLDIR]desktop\\BookVoice.exe&quot; &quot;%1&quot;', xml)

    def test_wxs_entrypoints_resolve_to_default_desktop_payload(self):
        payload = {"main.py", "desktop/BookVoice.exe"}
        with tempfile.TemporaryDirectory() as temp_dir:
            dist = Path(temp_dir) / "dist"
            (dist / "desktop").mkdir(parents=True)
            (dist / "main.py").write_text("print('ok')", encoding="utf-8")
            (dist / "desktop" / "BookVoice.exe").write_bytes(b"MZ")
            original_dist = build_msi.DIST
            build_msi.DIST = dist
            try:
                wxs = build_msi.build_wxs(
                    [(rel, dist / rel) for rel in payload], build_msi.PRODUCTS["user"]
                )
            finally:
                build_msi.DIST = original_dist

        for shortcut in wxs.iter("Shortcut"):
            target = shortcut.attrib["Target"]
            self.assertTrue(target.startswith("[INSTALLDIR]"))
            self.assertIn(target[len("[INSTALLDIR]"):].replace("\\", "/"), payload)
        command = next(
            value.attrib["Value"]
            for value in wxs.iter("RegistryValue")
            if value.attrib.get("Key", "").endswith("shell\\open\\command")
        )
        executable = command.split('"')[1].replace("[INSTALLDIR]", "", 1).replace("\\", "/")
        self.assertIn(executable, payload)

    def test_build_wxs_machine_targets_64_bit_program_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dist = Path(temp_dir) / "dist"
            dist.mkdir()
            (dist / "main.py").write_text("print('ok')", encoding="utf-8")
            (dist / "bookvoice.ico").write_bytes(b"ico")
            original_dist = build_msi.DIST
            build_msi.DIST = dist
            try:
                wxs = build_msi.build_wxs(
                    [("main.py", dist / "main.py")], build_msi.PRODUCTS["machine"]
                )
                xml = ET.tostring(wxs, encoding="unicode")
            finally:
                build_msi.DIST = original_dist

        self.assertIn("ProgramFiles64Folder", xml)
        self.assertIn('InstallScope="perMachine"', xml)
        self.assertIn('Platform="x64"', xml)
        self.assertTrue(all(component.get("Win64") == "yes" for component in wxs.iter("Component")))


class DesktopBuildTests(unittest.TestCase):
    def test_restored_package_directories_selects_only_package_paths(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            project = root / "BookVoice.App.csproj"
            project.parent.mkdir(exist_ok=True)
            project.write_text("", encoding="utf-8")
            obj = project.parent / "obj"
            obj.mkdir()
            package_a = root / "cache-a" / "Example.Package" / "1.0.0"
            package_b = root / "cache-b" / "Other.Package" / "2.0.0"
            package_a.mkdir(parents=True)
            package_b.mkdir(parents=True)
            (root / "cache-a" / "ProjectOnly").mkdir()
            assets = {
                "packageFolders": {str(root / "cache-a"): {}, str(root / "cache-b"): {}},
                "libraries": {
                    "Example.Package/1.0.0": {"type": "package", "path": "Example.Package/1.0.0"},
                    "Other.Package/2.0.0": {"type": "package", "path": "Other.Package/2.0.0"},
                    "repo/project": {"type": "project"},
                },
            }
            (obj / "project.assets.json").write_text(json.dumps(assets), encoding="utf-8")
            self.assertEqual(build._restored_package_directories_for_project(project), sorted([root / "cache-a", root / "cache-b", package_a, package_b], key=str))

    def test_visual_studio_msbuild_requires_matching_pri_task(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            install = root / "VS" / "Community"
            msbuild = install / "MSBuild" / "Current" / "Bin" / "MSBuild.exe"
            task = install / "MSBuild" / "Microsoft" / "VisualStudio" / "v17.0" / "AppxPackage" / "Microsoft.Build.Packaging.Pri.Tasks.dll"
            msbuild.parent.mkdir(parents=True)
            task.parent.mkdir(parents=True)
            msbuild.touch()
            task.touch()
            vswhere = root / "Microsoft Visual Studio" / "Installer" / "vswhere.exe"
            vswhere.parent.mkdir(parents=True)
            vswhere.touch()
            payload = json.dumps([{"installationPath": str(install), "installationVersion": "17.0"}])
            with patch.object(build, "subprocess") as proc, patch.dict(os.environ, {"ProgramFiles(x86)": str(root)}):
                proc.run.return_value = type("Result", (), {"stdout": payload})()
                self.assertEqual(build._visual_studio_msbuild(), str(msbuild))
                proc.run.assert_called_once_with(
                    [str(vswhere), "-products", "*", "-requires", "Microsoft.Component.MSBuild", "-format", "json"],
                    capture_output=True, text=True, check=False,
                )

    def test_stage_desktop_fails_loud_without_vs_instance(self):
        with patch.object(build, "_visual_studio_msbuild", return_value=None), self.assertRaisesRegex(SystemExit, "Build Tools"):
            build.stage_desktop()

    def test_stage_desktop_uses_msbuild_publish_properties(self):
        project = ROOT / "desktop" / "BookVoice.App" / "BookVoice.App.csproj"
        with tempfile.TemporaryDirectory() as temp_dir:
            dist = Path(temp_dir)
            old_dist = build.DIST
            build.DIST = dist
            try:
                with patch.object(build, "_require_visual_studio_msbuild", return_value=r"C:\\VS\\MSBuild.exe"), patch.object(build, "run") as run, patch.object(build.subprocess, "run"):
                    build.stage_desktop()
            finally:
                build.DIST = old_dist
        self.assertEqual(run.call_args_list[0].args[0][0], r"C:\\VS\\MSBuild.exe")
        publish = run.call_args_list[1].args[0]
        self.assertIn("/t:Publish", publish)
        self.assertIn("/p:Configuration=Release", publish)
        self.assertIn("/p:RuntimeIdentifier=win-x64", publish)
        self.assertIn("/p:Platform=x64", publish)
        self.assertTrue(any(str(p).startswith("/p:PublishDir=") for p in publish))


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

    def test_dist_includes_portable_worker_when_built(self):
        worker = ROOT / "dist" / "runtime" / "worker"
        if not worker.is_dir():
            self.skipTest("dist/runtime/worker not built yet — run python build.py")
        self.assertTrue((worker / "python.exe").is_file())
        self.assertTrue((worker / "python310.dll").is_file())
        self.assertTrue((worker / "Lib" / "site-packages" / "chatterbox").is_dir())
        self.assertFalse((ROOT / "dist" / "runtime" / "python").exists())


if __name__ == "__main__":
    unittest.main()
