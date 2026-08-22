from __future__ import annotations

import hashlib
import importlib.util
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


launcher_app = _load("launcher_app", ROOT / "launcher_app.py")
setup_bootstrapper = _load("setup_bootstrapper", ROOT / "scripts" / "setup_bootstrapper.py")
prepare_release_assets = _load(
    "prepare_release_assets_testable", ROOT / "scripts" / "prepare_release_assets.py"
)


def _make_install_layout(root: Path) -> Path:
    install = root / "BookVoice" / "App"
    (install / "static").mkdir(parents=True)
    (install / "Launcher.exe").write_bytes(b"MZ")
    (install / "main.py").write_text("print('app')", encoding="utf-8")
    (install / "static" / "index.html").write_text("<html></html>", encoding="utf-8")
    return install


class SplitArgsTests(unittest.TestCase):
    def test_launcher_flags_are_removed_from_forwarded_args(self):
        options, forwarded = launcher_app.split_args(
            ["--repair", "--browser", "--host", "lan", "--quiet"]
        )
        self.assertTrue(options["repair"])
        self.assertTrue(options["quiet"])
        self.assertEqual(forwarded, ["--browser", "--host", "lan"])

    def test_manifest_url_consumes_its_value(self):
        options, forwarded = launcher_app.split_args(
            ["--manifest-url", "https://example.test/assets.json", "--port", "8010"]
        )
        self.assertEqual(options["manifest-url"], "https://example.test/assets.json")
        self.assertEqual(forwarded, ["--port", "8010"])

    def test_bookvoice_positional_is_forwarded_as_absolute_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            book = Path(temp_dir) / "My Book.bookvoice"
            book.write_bytes(b"zip")
            _options, forwarded = launcher_app.split_args([str(book)])
            self.assertEqual(forwarded, [str(book.resolve())])

    def test_reinstall_alias_maps_like_repair(self):
        options, _forwarded = launcher_app.split_args(["--reinstall"])
        self.assertIn("reinstall", options)


class DiscoveryTests(unittest.TestCase):
    def test_looks_like_install_requires_launcher_and_payload(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            install = _make_install_layout(root)
            self.assertTrue(launcher_app.looks_like_install(install))

            (install / "Launcher.exe").unlink()
            self.assertFalse(launcher_app.looks_like_install(install))

    def test_discover_install_prefers_registry_anchor(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            install = _make_install_layout(Path(temp_dir))
            with patch.object(launcher_app, "candidate_from_registry_path") as anchor, patch.object(
                launcher_app, "candidate_from_association", return_value=None
            ), patch.object(launcher_app, "default_candidates", return_value=[]):
                anchor.side_effect = [install, None]
                self.assertEqual(launcher_app.discover_install(), install)

    def test_discover_install_falls_back_to_association_then_defaults(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            install = _make_install_layout(Path(temp_dir))
            with patch.object(
                launcher_app, "candidate_from_registry_path", return_value=None
            ), patch.object(
                launcher_app, "candidate_from_association"
            ) as association, patch.object(
                launcher_app, "default_candidates"
            ) as defaults:
                association.side_effect = [None, install]
                defaults.return_value = []
                self.assertEqual(launcher_app.discover_install(), install)

                association.side_effect = None
                association.return_value = None
                defaults.return_value = [install]
                self.assertEqual(launcher_app.discover_install(), install)

    def test_association_command_parsing_regex(self):
        import re

        command = '"C:\\Program Files\\BookVoice\\Launcher.exe" "%1"'
        pattern = r'"([^"]+)' + re.escape(launcher_app.LAUNCHER_EXE) + r'"'
        match = re.search(pattern, command)
        self.assertIsNotNone(match)
        directory = Path(f"{match.group(1)}{launcher_app.LAUNCHER_EXE}").parent
        self.assertEqual(directory, Path("C:\\Program Files\\BookVoice"))


class FakeBootstrapper:
    InstallCancelled = setup_bootstrapper.InstallCancelled

    MANIFEST = {
        "version": "9.9.9",
        "products": {
            "user": {"msi": "BookVoice-User.msi", "cabinets": ["cab1.cab"]},
            "machine": {"msi": "BookVoice.msi", "cabinets": ["cab1.cab"]},
        },
        "assets": {"BookVoice-User.msi": {"size": 1}, "BookVoice.msi": {"size": 1}, "cab1.cab": {"size": 100}},
    }

    def __init__(self, installer_code: int = 0, fail_download: Exception | None = None):
        self.DEFAULT_MANIFEST_URL = "https://example.test/releases/v1/release-assets.json"
        self.installer_code = installer_code
        self.fail_download = fail_download
        self.calls: list[str] = []

    def fetch_manifest(self, url):
        self.calls.append(f"fetch:{url}")
        return dict(self.MANIFEST)

    def validate_manifest(self, manifest):
        self.calls.append("validate")

    def ensure_files(self, manifest, base_url, product, progress=None, cancel_event=None):
        if cancel_event is not None and cancel_event.is_set():
            raise self.InstallCancelled("Cancelled.")
        if progress:
            progress({"kind": "plan", "files": 2, "bytes": 100})
            progress({"kind": "file", "name": "cab1.cab", "index": 1, "count": 2})
            progress({"kind": "bytes", "name": "cab1.cab", "received": 100, "size": 100})
        if self.fail_download:
            raise self.fail_download
        self.calls.append("ensure")
        return Path(tempfile.gettempdir()) / "fake-target"

    def run_installer(self, download_dir, msi_name, quiet):
        self.calls.append(f"install:{msi_name}:quiet={quiet}")
        return self.installer_code


def _drain(flow: launcher_app.InstallFlow) -> list[dict]:
    events = []
    while True:
        try:
            events.append(flow.events.get_nowait())
        except Exception:
            return events


class InstallFlowTests(unittest.TestCase):
    def _run_flow(self, fake) -> list[dict]:
        flow = launcher_app.InstallFlow({})
        with patch.object(launcher_app, "_load_bootstrapper", return_value=fake), patch.object(
            launcher_app, "acquire_setup_mutex", return_value=1234
        ), patch.object(launcher_app, "release_setup_mutex"):
            flow.run()
        return _drain(flow)

    def test_successful_flow_emits_progress_then_done(self):
        fake = FakeBootstrapper()
        events = self._run_flow(fake)
        kinds = [event["kind"] for event in events]
        self.assertEqual(kinds[-1], "done")
        self.assertIn("plan", kinds)
        self.assertIn("phase-install", kinds)
        self.assertIn("ensure", fake.calls)
        self.assertTrue(any(call.startswith("install:") for call in fake.calls))
        quiet_call = next(call for call in fake.calls if call.startswith("install:"))
        self.assertIn("quiet=True", quiet_call)

    def test_machine_scope_runs_msiexec_interactively(self):
        flow = launcher_app.InstallFlow({"machine": True})
        fake = FakeBootstrapper()
        with patch.object(launcher_app, "_load_bootstrapper", return_value=fake), patch.object(
            launcher_app, "acquire_setup_mutex", return_value=1234
        ), patch.object(launcher_app, "release_setup_mutex"), patch.object(
            launcher_app, "is_admin", return_value=True
        ):
            flow.run()
        _drain(flow)
        install_call = next(call for call in fake.calls if call.startswith("install:"))
        self.assertIn("quiet=False", install_call)

    def test_msiexec_failure_surfaces_error(self):
        fake = FakeBootstrapper(installer_code=1603)
        events = self._run_flow(fake)
        error = next(event for event in events if event["kind"] == "error")
        self.assertIn("1603", error["message"])

    def test_cancellation_is_reported(self):
        flow = launcher_app.InstallFlow({})
        flow.cancel_event.set()
        fake = FakeBootstrapper()
        events = self._run_flow_with_cancel(flow, fake)
        self.assertIn("cancelled", [event["kind"] for event in events])

    def _run_flow_with_cancel(self, flow, fake):
        with patch.object(launcher_app, "_load_bootstrapper", return_value=fake), patch.object(
            launcher_app, "acquire_setup_mutex", return_value=1234
        ), patch.object(launcher_app, "release_setup_mutex"):
            flow.run()
        return _drain(flow)

    def test_download_failure_becomes_error_event(self):
        fake = FakeBootstrapper(fail_download=RuntimeError("network down"))
        events = self._run_flow(fake)
        error = next(event for event in events if event["kind"] == "error")
        self.assertEqual(error["message"], "network down")


class BootstrapperContractTests(unittest.TestCase):
    def test_version_comes_from_repo_version_file(self):
        version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        self.assertEqual(setup_bootstrapper.RELEASE_VERSION, version)
        self.assertIn(f"/download/v{version}/", setup_bootstrapper.DEFAULT_MANIFEST_URL)

    def test_validate_manifest_rejects_untrusted_payloads(self):
        manifest = {
            "repository": "someone-else/bookvoice",
            "schemaVersion": 1,
            "version": setup_bootstrapper.RELEASE_VERSION,
            "tag": f"v{setup_bootstrapper.RELEASE_VERSION}",
        }
        with self.assertRaises(RuntimeError):
            setup_bootstrapper.validate_manifest(manifest)

    def test_plan_assets_rejects_unsafe_names(self):
        manifest = {
            "version": "1.0.0",
            "products": {"user": {"msi": "..\\evil.msi", "cabinets": []}},
            "assets": {},
        }
        with self.assertRaises(RuntimeError):
            setup_bootstrapper.plan_assets(manifest, "user")

    def test_ensure_files_skips_valid_assets_and_aborts_on_failure(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            payload = b"cabinet-bytes-here"
            msi_name = "BookVoice-User.msi"
            source = root / "source"
            source.mkdir()
            (source / msi_name).write_bytes(payload)
            digest = hashlib.sha256(payload).hexdigest()

            manifest = {
                "version": "1.0.0",
                "products": {
                    "user": {
                        "msi": msi_name,
                        "cabinets": ["missing.file"],
                    }
                },
                "assets": {
                    msi_name: {"size": len(payload), "sha256": digest},
                    "missing.file": {"size": 5, "sha256": "0" * 64},
                },
            }

            target = root / "downloads"
            target.mkdir()
            # A previously downloaded, still-valid MSI in the download dir is
            # reused instead of fetched again.
            (target / msi_name).write_bytes(payload)

            with patch.object(
                setup_bootstrapper,
                "plan_assets",
                return_value=(target, [msi_name, "missing.file"]),
            ):
                with patch.object(
                    setup_bootstrapper,
                    "download",
                    side_effect=RuntimeError("offline"),
                ) as download_mock:
                    with self.assertRaises(RuntimeError):
                        setup_bootstrapper.ensure_files(manifest, str(source), "user")

            # The already-valid MSI was skipped; only the missing cabinet
            # triggered a download attempt.
            download_mock.assert_called_once()
            self.assertEqual(download_mock.call_args.args[0], f"{source}/missing.file")
            self.assertEqual(download_mock.call_args.args[1], target / "missing.file")


class ReleaseManifestLauncherAssetTests(unittest.TestCase):
    def test_manifest_includes_launcher_when_present_but_not_in_products(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            release_root = Path(temp_dir)
            installer = release_root / "installer"
            installer.mkdir()
            (release_root / "VERSION").write_text("2.3.0\n", encoding="utf-8")
            (installer / "BookVoice-User.msi").write_bytes(b"user-msi")
            (installer / "BookVoice.msi").write_bytes(b"machine-msi")
            (installer / "cab1.cab").write_bytes(b"cabinet-one")
            (installer / "BookVoice-Launcher.exe").write_bytes(b"launcher-exe")

            manifest = prepare_release_assets.build_manifest(
                root=release_root, installer=installer
            )

        self.assertIn("BookVoice-Launcher.exe", manifest["assets"])
        self.assertNotIn(
            "BookVoice-Launcher.exe",
            sum((product["cabinets"] for product in manifest["products"].values()), []),
        )
        self.assertTrue(
            all(asset["sha256"] for asset in manifest["assets"].values())
        )

    def test_manifest_omits_launcher_when_absent(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            release_root = Path(temp_dir)
            installer = release_root / "installer"
            installer.mkdir()
            (release_root / "VERSION").write_text("2.3.0\n", encoding="utf-8")
            (installer / "BookVoice-User.msi").write_bytes(b"user-msi")
            (installer / "BookVoice.msi").write_bytes(b"machine-msi")
            (installer / "cab1.cab").write_bytes(b"cabinet-one")

            manifest = prepare_release_assets.build_manifest(
                root=release_root, installer=installer
            )

        self.assertNotIn("BookVoice-Launcher.exe", manifest["assets"])


class DownloadMatrixTests(unittest.TestCase):
    """Table-driven coverage for the resume/download state machine (H1)."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.payload = b"0123456789"
        self.expected = {
            "size": len(self.payload),
            "sha256": hashlib.sha256(self.payload).hexdigest(),
        }
        self.url = "https://example.test/cab1.cab"

    class FakeResponse:
        def __init__(self, status=206, chunks=()):
            self.status = status
            self._chunks = list(chunks)

        def read(self, _size):
            return self._chunks.pop(0) if self._chunks else b""

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def _run(self, script, part_bytes=None, cancel_event=None):
        target = self.dir / "cab1.cab"
        if part_bytes is not None:
            (target.parent / "cab1.cab.part").write_bytes(part_bytes)
        ranges = []

        def fake_urlopen(request, timeout=None):
            ranges.append(request.headers.get("Range"))
            item = script.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        with patch.object(
            setup_bootstrapper.urllib.request, "urlopen", side_effect=fake_urlopen
        ):
            setup_bootstrapper.download(
                self.url, target, self.expected, cancel_event=cancel_event
            )
        self.assertEqual(script, [], "scripted responses were not consumed")
        return target.read_bytes(), ranges

    def test_full_size_part_is_promoted_without_network(self):
        content, ranges = self._run([], part_bytes=self.payload)
        self.assertEqual(content, self.payload)
        self.assertEqual(ranges, [])
        self.assertFalse((self.dir / "cab1.cab.part").exists())

    def test_corrupt_full_size_part_redownloads_from_scratch(self):
        content, ranges = self._run(
            [self.FakeResponse(206, [self.payload])], part_bytes=b"corrupt!!1"
        )
        self.assertEqual(content, self.payload)
        self.assertEqual(ranges, [None])

    def test_oversize_part_resets_to_plain_get(self):
        content, ranges = self._run(
            [self.FakeResponse(200, [self.payload])], part_bytes=b"x" * 15
        )
        self.assertEqual(content, self.payload)
        self.assertEqual(ranges, [None])

    def test_resume_sends_range_and_appends_tail(self):
        head, tail = b"01234", b"56789"
        content, ranges = self._run(
            [self.FakeResponse(206, [tail])], part_bytes=head
        )
        self.assertEqual(content, head + tail)
        self.assertEqual(ranges, ["bytes=5-"])

    def test_non_206_answer_restarts_cleanly(self):
        content, ranges = self._run(
            [self.FakeResponse(200, [self.payload])], part_bytes=b"01234"
        )
        self.assertEqual(content, self.payload)
        self.assertEqual(ranges[0], "bytes=5-")

    def test_http416_resets_offset_then_succeeds(self):
        stale = b"stale"
        error = urllib.error.HTTPError(self.url, 416, "Range Not Satisfiable", None, None)
        content, ranges = self._run(
            [error, self.FakeResponse(206, [self.payload])], part_bytes=stale
        )
        self.assertEqual(content, self.payload)
        self.assertEqual(ranges, ["bytes=5-", None])

    def test_cancel_mid_chunk_preserves_partial(self):
        event = threading.Event()
        chunks = [b"01234"]
        outer = self

        class CancellingResponse(outer.FakeResponse):
            def read(self, size):
                chunk = super().read(size)
                event.set()
                return chunk

        target = self.dir / "cab1.cab"
        with patch.object(
            setup_bootstrapper.urllib.request,
            "urlopen",
            return_value=CancellingResponse(206, chunks),
        ):
            with self.assertRaises(setup_bootstrapper.InstallCancelled):
                setup_bootstrapper.download(
                    self.url,
                    target,
                    self.expected,
                    cancel_event=event,
                )
        self.assertTrue((self.dir / "cab1.cab.part").exists())
        self.assertFalse(target.exists())


class _WidgetStub:
    def __init__(self):
        self.calls = []
        self.state = "normal"

    def configure(self, **kwargs):
        self.calls.append(kwargs)
        if "state" in kwargs:
            self.state = kwargs["state"]


class InstallWindowStateTests(unittest.TestCase):
    """Headless state-machine checks on the install dialog's event handler."""

    def _window(self):
        window = object.__new__(launcher_app.InstallWindow)
        finished = []
        window.on_finished = lambda: finished.append(True)
        window.installing = False
        window.file_name = ""
        window.file_size = 0
        window.file_index = 0
        window.file_count = 0
        window.bar = SimpleNamespace(configure=lambda **kw: None)
        window.status = SimpleNamespace(text="", set=lambda value: None)
        window.close_button = _WidgetStub()
        window.retry_button = _WidgetStub()

        destroyed = []
        window.root = SimpleNamespace(
            destroy=lambda: destroyed.append(True),
            after=lambda *a, **kw: None,
        )
        return window, finished, destroyed

    def test_done_launches_immediately_and_disables_close(self):
        window, finished, _destroyed = self._window()
        keep_going = window.handle({"kind": "done"})
        self.assertFalse(keep_going)
        self.assertEqual(finished, [True])
        self.assertIn("disabled", window.close_button.state)

    def test_phase_install_blocks_cancelling(self):
        import queue as queue_module

        flow = SimpleNamespace(cancel_event=threading.Event(), events=queue_module.Queue())
        window, _finished, destroyed = self._window()
        window.flow = flow
        window.handle({"kind": "phase-install"})
        self.assertTrue(window.installing)
        window.cancel()
        self.assertEqual(destroyed, [])
        self.assertFalse(flow.cancel_event.is_set())

    def test_error_enables_retry_and_close(self):
        window, _finished, _destroyed = self._window()
        window.handle({"kind": "error", "message": "boom"})
        self.assertIn("normal", window.retry_button.state)
        self.assertIn("normal", window.close_button.state)
        self.assertFalse(window.installing)

    def test_bytes_progress_consumes_event_size(self):
        seen = {}

        def record(**kwargs):
            seen.update(kwargs)

        window, _finished, _destroyed = self._window()
        window.bar.configure = record
        window.file_name = "cab9.cab"
        window.file_index = 2
        window.file_count = 33
        window.handle({"kind": "bytes", "received": 50, "size": 100})
        self.assertEqual(seen.get("value"), 5000)


class ElevationTests(unittest.TestCase):
    def test_arguments_are_forwarded_verbatim(self):
        argv = ["--machine", "--quiet", "My Book.bookvoice"]
        with patch.object(
            launcher_app.ctypes.windll.shell32,
            "ShellExecuteW",
            return_value=42,
        ) as execute:
            ok = launcher_app.elevate_and_restart(argv)
        self.assertTrue(ok)
        command_line = execute.call_args[0][3]
        self.assertIn("--machine", command_line)
        self.assertIn("--quiet", command_line)
        self.assertIn("Book.bookvoice", command_line)


class BuildMsiAnchorTests(unittest.TestCase):
    def test_wxs_writes_install_path_anchor(self):
        import build_msi
        from xml.etree import ElementTree as ET

        with tempfile.TemporaryDirectory() as temp_dir:
            dist = Path(temp_dir) / "dist"
            dist.mkdir()
            (dist / "main.py").write_text("print('ok')", encoding="utf-8")
            original_dist = build_msi.DIST
            build_msi.DIST = dist
            try:
                wxs = build_msi.build_wxs(
                    [("main.py", dist / "main.py")], build_msi.PRODUCTS["user"]
                )
                xml = ET.tostring(wxs, encoding="unicode")
            finally:
                build_msi.DIST = original_dist
        self.assertIn("Software\\BookVoice\\Install", xml)
        self.assertIn("[INSTALLDIR]", xml)


if __name__ == "__main__":
    unittest.main()
