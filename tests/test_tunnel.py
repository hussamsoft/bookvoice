"""Cloudflare Tunnel wiring: a stable address that survives restarts."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import launch  # noqa: E402
import tunnel  # noqa: E402


TUNNEL_ENV = {
    "BOOKVOICE_TUNNEL": "",
    "BOOKVOICE_TUNNEL_HOSTNAME": "",
    "BOOKVOICE_TUNNEL_NAME": "",
    "BOOKVOICE_TUNNEL_TOKEN": "",
    "BOOKVOICE_TUNNEL_CONFIG": "",
    "BOOKVOICE_CLOUDFLARED": "",
}


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = self.temp.name

    def tearDown(self):
        self.temp.cleanup()

    def test_no_tunnel_is_configured_by_default(self):
        with patch.dict(os.environ, TUNNEL_ENV):
            settings = tunnel.resolve_settings(self.runtime)
        self.assertFalse(tunnel.is_enabled(settings))

    def test_settings_persist_so_the_hostname_is_entered_once(self):
        with patch.dict(os.environ, TUNNEL_ENV):
            first = tunnel.resolve_settings(self.runtime, {
                "mode": "cloudflare",
                "name": "bookvoice",
                "hostname": "bookvoice.example.com",
            })
            tunnel.save_settings(self.runtime, first)

            # A later launch supplies nothing and must come back identical.
            second = tunnel.resolve_settings(self.runtime)

        self.assertTrue(tunnel.is_enabled(second))
        self.assertTrue(tunnel.is_named(second))
        self.assertEqual(second["hostname"], "bookvoice.example.com")
        self.assertEqual(second["name"], "bookvoice")

    def test_an_argument_overrides_the_stored_value(self):
        with patch.dict(os.environ, TUNNEL_ENV):
            tunnel.save_settings(self.runtime, {
                "mode": "cloudflare", "name": "old", "hostname": "old.example.com",
            })
            settings = tunnel.resolve_settings(self.runtime, {"hostname": "new.example.com"})
        self.assertEqual(settings["hostname"], "new.example.com")
        self.assertEqual(settings["name"], "old")

    def test_the_environment_overrides_stored_settings(self):
        tunnel.save_settings(self.runtime, {"mode": "cloudflare", "hostname": "stored.example.com"})
        with patch.dict(os.environ, {**TUNNEL_ENV, "BOOKVOICE_TUNNEL_HOSTNAME": "env.example.com"}):
            settings = tunnel.resolve_settings(self.runtime)
        self.assertEqual(settings["hostname"], "env.example.com")

    def test_a_hostname_alone_is_taken_as_a_request_for_a_tunnel(self):
        with patch.dict(os.environ, TUNNEL_ENV):
            settings = tunnel.resolve_settings(self.runtime, {"hostname": "bookvoice.example.com"})
        self.assertTrue(tunnel.is_enabled(settings))

    def test_a_quick_tunnel_is_not_treated_as_stable(self):
        with patch.dict(os.environ, TUNNEL_ENV):
            settings = tunnel.resolve_settings(self.runtime, {"mode": "cloudflare"})
        self.assertTrue(tunnel.is_enabled(settings))
        # No hostname: Cloudflare will issue a different address every start.
        self.assertFalse(tunnel.is_named(settings))

    def test_corrupt_settings_are_ignored_rather_than_crashing_startup(self):
        tunnel.settings_path(self.runtime).write_text("{not json", encoding="utf-8")
        self.assertEqual(tunnel.load_settings(self.runtime), {})

    def test_saved_settings_are_written_atomically_as_json(self):
        tunnel.save_settings(self.runtime, {"mode": "cloudflare", "hostname": "a.example.com"})
        stored = json.loads(tunnel.settings_path(self.runtime).read_text(encoding="utf-8"))
        self.assertEqual(stored["hostname"], "a.example.com")
        self.assertFalse(list(Path(self.runtime).glob("*.tmp")))


class CommandTests(unittest.TestCase):
    def test_the_local_port_is_passed_per_run_not_baked_into_config(self):
        # The launcher picks a free port at startup; it is not always the same,
        # so config.yml cannot hardcode the origin.
        first = tunnel.build_command({"name": "bookvoice"}, 8000, "cloudflared")
        second = tunnel.build_command({"name": "bookvoice"}, 8004, "cloudflared")
        self.assertIn("http://127.0.0.1:8000", first)
        self.assertIn("http://127.0.0.1:8004", second)
        self.assertEqual(first[-2:], ["run", "bookvoice"])

    def test_a_quick_tunnel_runs_without_a_tunnel_name(self):
        command = tunnel.build_command({}, 8000, "cloudflared")
        self.assertNotIn("run", command)
        self.assertIn("--url", command)

    def test_an_explicit_config_file_is_honoured(self):
        command = tunnel.build_command({"config": "C:/cf/config.yml"}, 8000, "cloudflared")
        self.assertIn("--config", command)
        self.assertIn("C:/cf/config.yml", command)

    def test_the_public_origin_is_https_and_normalized(self):
        self.assertEqual(
            tunnel.public_origin({"hostname": "bookvoice.example.com"}),
            "https://bookvoice.example.com",
        )
        self.assertEqual(
            tunnel.public_origin({"hostname": "https://bookvoice.example.com/"}),
            "https://bookvoice.example.com",
        )
        self.assertEqual(tunnel.public_origin({}), "")

    def test_a_missing_cloudflared_is_reported_with_guidance(self):
        with patch.object(tunnel.shutil, "which", return_value=None):
            with self.assertRaisesRegex(tunnel.TunnelError, "cloudflared was not found"):
                tunnel.find_cloudflared()


class DashboardTunnelTests(unittest.TestCase):
    """Tunnels created in the Cloudflare dashboard take their config from the cloud."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp.cleanup()

    def test_a_token_run_sends_no_url_or_config(self):
        # Cloudflare serves the ingress for these; --url and --config are
        # ignored, so sending them would only imply a control that does nothing.
        command = tunnel.build_command({"token": "eyJtoken", "config": "C:/cf.yml"}, 8000, "cloudflared")
        self.assertNotIn("--url", command)
        self.assertNotIn("--config", command)
        self.assertEqual(command[-3:], ["run", "--token", "eyJtoken"])

    def test_a_dashboard_tunnel_counts_as_a_stable_address(self):
        settings = {"mode": "cloudflare", "token": "eyJtoken", "hostname": "voice.example.com"}
        self.assertTrue(tunnel.is_remote_managed(settings))
        self.assertTrue(tunnel.is_named(settings))
        self.assertEqual(tunnel.public_origin(settings), "https://voice.example.com")

    def test_a_token_alone_is_taken_as_a_request_for_a_tunnel(self):
        with patch.dict(os.environ, TUNNEL_ENV):
            settings = tunnel.resolve_settings(self.temp.name, {"token": "eyJtoken"})
        self.assertTrue(tunnel.is_enabled(settings))
        self.assertTrue(tunnel.is_remote_managed(settings))

    def test_the_token_is_kept_out_of_the_log(self):
        command = tunnel.build_command({"token": "eyJverysecrettoken"}, 8000, "cloudflared")
        rendered = tunnel.redact_command(command)
        self.assertNotIn("eyJverysecrettoken", rendered)
        self.assertIn("<token>", rendered)

    def test_a_dashboard_tunnel_without_a_hostname_is_called_out(self):
        # Without it the browser origin is unknown and every request is refused.
        warning = tunnel.missing_hostname_warning({"token": "eyJtoken"})
        self.assertIn("--tunnel-hostname", warning)
        self.assertEqual(
            tunnel.missing_hostname_warning({"token": "eyJtoken", "hostname": "voice.example.com"}),
            "",
        )
        self.assertEqual(tunnel.missing_hostname_warning({"name": "bookvoice"}), "")

    def test_a_token_tunnel_starts_without_waiting_for_a_printed_url(self):
        # A dashboard tunnel never announces a URL, so waiting would just stall.
        process = MagicMock()
        process.stdout = iter([])
        process.poll.return_value = None
        settings = {"mode": "cloudflare", "token": "eyJtoken", "hostname": "voice.example.com"}
        with patch.object(tunnel, "find_cloudflared", return_value="cloudflared"), \
                patch.object(subprocess, "Popen", return_value=process), \
                patch.object(tunnel, "QUICK_URL_TIMEOUT_S", 30):
            started = tunnel.start_tunnel(settings, 8000, self.temp.name)
        self.assertEqual(started.url, "https://voice.example.com")

    def test_token_settings_persist_so_it_is_pasted_once(self):
        with patch.dict(os.environ, TUNNEL_ENV):
            tunnel.save_settings(self.temp.name, tunnel.resolve_settings(self.temp.name, {
                "mode": "cloudflare", "token": "eyJtoken", "hostname": "voice.example.com",
            }))
            later = tunnel.resolve_settings(self.temp.name)
        self.assertEqual(later["token"], "eyJtoken")
        self.assertEqual(later["hostname"], "voice.example.com")


class PinnedPortTests(unittest.TestCase):
    def test_no_pin_means_scan_as_before(self):
        with patch.dict(os.environ, {"BOOKVOICE_PORT": ""}):
            self.assertEqual(launch.resolve_pinned_port(None), 0)

    def test_an_explicit_port_is_used(self):
        self.assertEqual(launch.resolve_pinned_port(8000), 8000)
        with patch.dict(os.environ, {"BOOKVOICE_PORT": "8123"}):
            self.assertEqual(launch.resolve_pinned_port(None), 8123)

    def test_nonsense_ports_fall_back_to_scanning(self):
        for value in ("abc", "0", "70000", "-1"):
            with patch.dict(os.environ, {"BOOKVOICE_PORT": value}):
                self.assertEqual(launch.resolve_pinned_port(None), 0)

    def test_a_pinned_port_is_honoured_even_when_busy(self):
        # Silently moving would look like a broken tunnel rather than a
        # port conflict, so it starts there anyway and says so.
        log = MagicMock()
        with patch.object(launch.socket, "socket") as sock:
            sock.return_value.__enter__.return_value.bind.side_effect = OSError("in use")
            self.assertEqual(launch.pick_port(log, "127.0.0.1", pinned=8000), 8000)
        self.assertIn("already in use", log.write.call_args[0][0])

    def test_scanning_still_finds_the_first_free_port(self):
        log = MagicMock()
        attempts = []

        def bind(address):
            attempts.append(address[1])
            if address[1] < 8002:
                raise OSError("in use")

        with patch.object(launch.socket, "socket") as sock:
            sock.return_value.__enter__.return_value.bind.side_effect = bind
            self.assertEqual(launch.pick_port(log, "127.0.0.1"), 8002)
        self.assertEqual(attempts, [8000, 8001, 8002])


class TunnelProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp.cleanup()

    def _process(self, lines):
        process = MagicMock()
        process.stdout = iter(lines)
        process.poll.return_value = None
        return process

    def test_a_named_tunnel_reports_its_permanent_hostname_immediately(self):
        settings = {"mode": "cloudflare", "name": "bookvoice", "hostname": "bookvoice.example.com"}
        with patch.object(tunnel, "find_cloudflared", return_value="cloudflared"), \
                patch.object(subprocess, "Popen", return_value=self._process([])):
            started = tunnel.start_tunnel(settings, 8000, self.temp.name)

        self.assertEqual(started.url, "https://bookvoice.example.com")
        stored = tunnel.load_settings(self.temp.name)
        self.assertEqual(stored["lastUrl"], "https://bookvoice.example.com")

    def test_a_quick_tunnel_url_is_read_from_the_cloudflared_output(self):
        lines = [
            "INF Requesting new quick tunnel...\n",
            "INF +----------------------------------------+\n",
            "INF |  https://odd-forest-1234.trycloudflare.com  |\n",
        ]
        with patch.object(tunnel, "find_cloudflared", return_value="cloudflared"), \
                patch.object(subprocess, "Popen", return_value=self._process(lines)):
            started = tunnel.start_tunnel({"mode": "cloudflare"}, 8000, self.temp.name)

        self.assertEqual(started.url, "https://odd-forest-1234.trycloudflare.com")

    def test_a_tunnel_that_never_reports_a_url_fails_instead_of_hanging(self):
        with patch.object(tunnel, "find_cloudflared", return_value="cloudflared"), \
                patch.object(subprocess, "Popen", return_value=self._process([])), \
                patch.object(tunnel, "QUICK_URL_TIMEOUT_S", 0.2):
            with self.assertRaisesRegex(tunnel.TunnelError, "did not report a tunnel URL"):
                tunnel.start_tunnel({"mode": "cloudflare"}, 8000, self.temp.name)

    def test_stopping_terminates_cloudflared(self):
        process = self._process([])
        instance = tunnel.CloudflareTunnel({"hostname": "a.example.com"}, 8000)
        instance.process = process

        instance.stop()

        process.terminate.assert_called_once()


class LauncherTunnelEnvironmentTests(unittest.TestCase):
    def test_the_tunnel_hostname_becomes_a_trusted_origin(self):
        env = launch.apply_tunnel_env({}, "https://bookvoice.example.com")
        self.assertEqual(env["BOOKVOICE_PUBLIC_ORIGIN"], "https://bookvoice.example.com")
        self.assertEqual(env["BOOKVOICE_COOKIE_SECURE"], "1")

    def test_a_lan_bind_and_a_tunnel_can_be_served_at_once(self):
        env = launch.apply_network_env({}, "0.0.0.0")
        env = launch.apply_tunnel_env(env, "https://bookvoice.example.com")
        # Plain HTTP on the LAN would discard a Secure cookie, so the weaker
        # setting has to survive; the tunnel works either way.
        self.assertEqual(env["BOOKVOICE_COOKIE_SECURE"], "0")
        self.assertEqual(env["BOOKVOICE_ALLOW_PRIVATE_ORIGINS"], "1")
        self.assertIn("bookvoice.example.com", env["BOOKVOICE_PUBLIC_ORIGIN"])

    def test_an_existing_origin_is_kept_alongside_the_tunnel(self):
        env = launch.apply_tunnel_env(
            {"BOOKVOICE_PUBLIC_ORIGIN": "https://other.example.com"},
            "https://bookvoice.example.com",
        )
        self.assertIn("https://other.example.com", env["BOOKVOICE_PUBLIC_ORIGIN"])
        self.assertIn("https://bookvoice.example.com", env["BOOKVOICE_PUBLIC_ORIGIN"])

    def test_no_origin_means_no_change(self):
        self.assertEqual(launch.apply_tunnel_env({}, ""), {})


if __name__ == "__main__":
    unittest.main()
