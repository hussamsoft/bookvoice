"""Cover the update check, staging and handoff.

Nothing checked for updates before this: launcher_app.main() spawns the app the
moment discover_install() succeeds, so an installed 2.6.1 could not learn that
2.6.2 fixed the launcher crash it was running. These tests pin the parts that
decide whether someone is told, and the exit-code protocol that keeps the
watchdog from restarting the app underneath msiexec.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from services import update_service  # noqa: E402


class VersionComparisonTests(unittest.TestCase):
    def test_parses_release_versions_with_and_without_the_v_prefix(self):
        self.assertEqual(update_service.parse_version("2.6.3"), (2, 6, 3))
        self.assertEqual(update_service.parse_version("v2.6.3"), (2, 6, 3))

    def test_unparseable_versions_are_never_treated_as_releases(self):
        """A source checkout reports "dev"; it must not be told it is stale."""
        for value in ("dev", "", None, "2.6.3-rc1", "latest"):
            with self.subTest(value=value):
                self.assertIsNone(update_service.parse_version(value))
                self.assertFalse(update_service.is_newer(value, "2.6.3"))
                self.assertFalse(update_service.is_newer("2.6.3", value))

    def test_ordering_is_numeric_not_lexicographic(self):
        """String comparison puts 2.10.0 before 2.9.0 and misses the update."""
        self.assertTrue(update_service.is_newer("2.10.0", "2.9.0"))
        self.assertFalse(update_service.is_newer("2.9.0", "2.10.0"))
        self.assertFalse(update_service.is_newer("2.6.3", "2.6.3"))
        self.assertTrue(update_service.is_newer("2.6.4", "2.6.3"))


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patcher = patch.dict(os.environ, {"DATA_DIR": self.temp.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_hosted_deployment_is_never_offered_an_update(self):
        """The viewer is not on the machine that would need restarting."""
        with patch.object(update_service, "server_mode", return_value=True):
            with patch.object(update_service, "_fetch_latest_tag") as fetch:
                result = update_service.check(force=True)
        self.assertFalse(result["supported"])
        self.assertFalse(result["updateAvailable"])
        fetch.assert_not_called()

    def test_turning_the_check_off_stops_the_outbound_request(self):
        with patch.object(update_service, "supported", return_value=True):
            with patch.object(update_service, "enabled", return_value=False):
                with patch.object(update_service, "_fetch_latest_tag") as fetch:
                    result = update_service.check(force=True)
        self.assertFalse(result["enabled"])
        fetch.assert_not_called()

    def test_a_newer_release_is_reported_with_its_tag_url(self):
        with patch.object(update_service, "supported", return_value=True):
            with patch.object(update_service, "enabled", return_value=True):
                with patch.object(update_service, "app_version", return_value="2.6.3"):
                    with patch.object(update_service, "_fetch_latest_tag", return_value="v2.7.0"):
                        result = update_service.check(force=True)
        self.assertTrue(result["updateAvailable"])
        self.assertEqual(result["latest"], "2.7.0")
        self.assertTrue(result["releaseUrl"].endswith("/tag/v2.7.0"))

    def test_a_network_failure_reports_an_error_rather_than_raising(self):
        """An update check is not worth interrupting someone's reading over."""
        with patch.object(update_service, "supported", return_value=True):
            with patch.object(update_service, "enabled", return_value=True):
                with patch.object(
                    update_service, "_fetch_latest_tag", side_effect=OSError("no route to host")
                ):
                    result = update_service.check(force=True)
        self.assertIsNotNone(result["error"])
        self.assertFalse(result["updateAvailable"])
        self.assertIsNone(result["latest"])

    def test_a_stale_cache_still_reports_the_last_known_release_when_offline(self):
        cache = Path(self.temp.name) / "update-check.json"
        cache.write_text(json.dumps({"latest": "2.7.0", "checkedAt": 0}), encoding="utf-8")
        with patch.object(update_service, "supported", return_value=True):
            with patch.object(update_service, "enabled", return_value=True):
                with patch.object(update_service, "app_version", return_value="2.6.3"):
                    with patch.object(
                        update_service, "_fetch_latest_tag", side_effect=OSError("offline")
                    ):
                        result = update_service.check(force=True)
        self.assertEqual(result["latest"], "2.7.0")
        self.assertTrue(result["updateAvailable"])
        self.assertIsNotNone(result["error"])

    def test_a_fresh_cache_is_reused_instead_of_asking_github_again(self):
        import time

        cache = Path(self.temp.name) / "update-check.json"
        cache.write_text(
            json.dumps({"latest": "2.7.0", "checkedAt": time.time()}), encoding="utf-8"
        )
        with patch.object(update_service, "supported", return_value=True):
            with patch.object(update_service, "enabled", return_value=True):
                with patch.object(update_service, "_fetch_latest_tag") as fetch:
                    result = update_service.check(force=False)
        fetch.assert_not_called()
        self.assertEqual(result["latest"], "2.7.0")


class ManifestTrustTests(unittest.TestCase):
    def _manifest(self, **overrides):
        manifest = {
            "schemaVersion": 1,
            "repository": update_service.REPOSITORY,
            "version": "2.7.0",
            "tag": "v2.7.0",
            "assets": {update_service.LAUNCHER_ASSET: {"size": 10, "sha256": "ab"}},
        }
        manifest.update(overrides)
        return manifest

    @staticmethod
    def _serving(payload: dict):
        """Patch urlopen to serve one JSON body, leaving validation untouched."""
        body = io.BytesIO(json.dumps(payload).encode("utf-8"))
        response = MagicMock()
        response.__enter__.return_value = body
        response.__exit__.return_value = False
        return patch.object(
            update_service.urllib.request, "urlopen", return_value=response
        )

    def test_a_matching_manifest_is_accepted(self):
        """Positive control: without this the rejection tests could pass vacuously."""
        with self._serving(self._manifest()):
            manifest = update_service._fetch_manifest("v2.7.0")
        self.assertEqual(manifest["tag"], "v2.7.0")

    def test_a_manifest_for_a_different_tag_is_rejected(self):
        """Serving v2.6.0's manifest under the v2.7.0 URL must not install v2.6.0."""
        for overrides in (
            {"tag": "v2.6.0"},
            {"version": "2.6.0"},
            {"repository": "someone/else"},
            {"schemaVersion": 2},
        ):
            with self.subTest(overrides=overrides):
                with self._serving(self._manifest(**overrides)):
                    with self.assertRaises(RuntimeError):
                        update_service._fetch_manifest("v2.7.0")


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patcher = patch.dict(os.environ, {"DATA_DIR": self.temp.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_install_refuses_before_the_installer_has_been_staged(self):
        with patch.object(update_service, "supported", return_value=True):
            with self.assertRaises(FileNotFoundError):
                update_service.begin_install("2.7.0")

    def test_install_writes_the_sentinel_the_watchdog_reads(self):
        staged = Path(self.temp.name) / "updates" / "2.7.0" / update_service.LAUNCHER_ASSET
        staged.parent.mkdir(parents=True)
        staged.write_bytes(b"installer")

        started = []
        with patch.object(update_service, "supported", return_value=True):
            with patch.object(update_service.threading, "Thread") as thread:
                thread.side_effect = lambda **kw: started.append(kw) or unittest.mock.MagicMock()
                payload = update_service.begin_install("2.7.0")

        self.assertEqual(payload["version"], "2.7.0")
        written = json.loads(update_service.pending_path().read_text(encoding="utf-8"))
        self.assertEqual(written["installer"], str(staged))
        # The exit must be deferred, not immediate: the 202 has to reach the
        # browser before the process goes away.
        self.assertTrue(started, "begin_install did not defer the exit to a thread")

    def test_consume_pending_clears_the_sentinel_so_it_fires_once(self):
        update_service.pending_path().parent.mkdir(parents=True, exist_ok=True)
        update_service.pending_path().write_text(
            json.dumps({"version": "2.7.0", "installer": "x"}), encoding="utf-8"
        )
        self.assertIsNotNone(update_service.consume_pending())
        self.assertIsNone(update_service.consume_pending())

    def test_spawn_installer_passes_reinstall(self):
        """Without --reinstall the launcher just restarts the old version."""
        staged = Path(self.temp.name) / update_service.LAUNCHER_ASSET
        staged.write_bytes(b"installer")
        with patch.object(update_service.subprocess, "Popen") as popen:
            self.assertTrue(update_service.spawn_installer({"installer": str(staged)}))
        args = popen.call_args.args[0]
        self.assertEqual(args[0], str(staged))
        self.assertIn("--reinstall", args)

    def test_spawn_installer_reports_a_missing_staged_file(self):
        self.assertFalse(update_service.spawn_installer({"installer": "nope.exe"}))


if __name__ == "__main__":
    unittest.main()
