from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

import build


ROOT = Path(__file__).resolve().parent.parent


class RuntimeBundleContractTests(unittest.TestCase):
    def _load_runtime_stage(self):
        script = ROOT / "scripts" / "stage_runtime_bundle.py"
        spec = importlib.util.spec_from_file_location("stage_runtime_bundle", script)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module

    def test_runtime_bundle_requires_an_immutable_worker_environment(self):
        module = self._load_runtime_stage()
        self.assertIn("easyocr", module.REQUIRED_PACKAGES)
        self.assertIn("deep_translator", module.REQUIRED_PACKAGES)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.assertFalse(module.runtime_bundle_is_ready(root))

            python = root / "python.exe"
            python.parent.mkdir(parents=True, exist_ok=True)
            python.write_bytes(b"python")
            (root / "python310.dll").write_bytes(b"dll")
            for package in module.REQUIRED_PACKAGES:
                if package == "soundfile":
                    module_file = root / "Lib" / "site-packages" / "soundfile.py"
                    module_file.parent.mkdir(parents=True, exist_ok=True)
                    module_file.write_text("", encoding="utf-8")
                else:
                    (root / "Lib" / "site-packages" / package).mkdir(parents=True)

            self.assertTrue(module.runtime_bundle_is_ready(root))

    def test_runtime_manifest_never_allows_first_launch_package_installation(self):
        module = self._load_runtime_stage()
        with tempfile.TemporaryDirectory() as temp_dir:
            manifest = module.write_runtime_manifest(Path(temp_dir), "1.10.1")

        self.assertEqual(manifest["schema_version"], 1)
        self.assertEqual(manifest["startup_provisioning"], "forbidden")
        self.assertEqual(manifest["worker_python"], "runtime/worker/python.exe")

    def test_build_validation_rejects_a_runtime_that_can_provision_at_startup(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            dist = Path(temp_dir)
            (dist / "runtime-manifest.json").write_text(
                '{"startup_provisioning":"allowed"}\n', encoding="utf-8"
            )

            errors = build.runtime_contract_errors(dist)

        self.assertIn("runtime manifest forbids no startup provisioning", errors)

    def test_launcher_uses_only_the_packaged_worker_runtime(self):
        launch_spec = importlib.util.spec_from_file_location("bookvoice_launch", ROOT / "launch.py")
        launch = importlib.util.module_from_spec(launch_spec)
        assert launch_spec and launch_spec.loader
        launch_spec.loader.exec_module(launch)

        with tempfile.TemporaryDirectory() as temp_dir:
            app_dir = Path(temp_dir)
            worker = app_dir / "runtime" / "worker" / "python.exe"
            worker.parent.mkdir(parents=True)
            worker.write_bytes(b"python")

            self.assertEqual(launch.bundled_worker_python(str(app_dir)), str(worker))

    def test_launcher_locks_a_readable_minimum_window_size(self):
        launch_spec = importlib.util.spec_from_file_location("bookvoice_launch_window", ROOT / "launch.py")
        launch = importlib.util.module_from_spec(launch_spec)
        assert launch_spec and launch_spec.loader
        launch_spec.loader.exec_module(launch)

        class FakeWebview:
            def __init__(self):
                self.arguments = None

            def create_window(self, *args, **kwargs):
                self.arguments = (args, kwargs)
                return object()

        fake = FakeWebview()
        launch.create_main_window(fake)

        _, kwargs = fake.arguments
        # The side-by-side reader layout switches on at 1024 px; the window
        # must never shrink below the point where the layout would squish.
        self.assertEqual(kwargs["min_size"], (1024, 700))
        self.assertGreaterEqual(kwargs["width"], kwargs["min_size"][0])
        self.assertGreaterEqual(kwargs["height"], kwargs["min_size"][1])
        self.assertTrue(kwargs["resizable"])
        # Native Windows chrome owns snap layouts, resize borders, taskbar-aware
        # maximization, and standard double-click maximize/restore behavior.
        self.assertFalse(kwargs["frameless"])
        self.assertFalse(kwargs["easy_drag"])
        self.assertNotIn("js_api", kwargs)

if __name__ == "__main__":
    unittest.main()
