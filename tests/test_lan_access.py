"""Binding beyond loopback, and the origin policy that goes with it."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
for candidate in (ROOT, BACKEND):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

import launch  # noqa: E402
from services import security  # noqa: E402


class BindHostTests(unittest.TestCase):
    def test_loopback_is_the_default(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BOOKVOICE_HOST", None)
            self.assertEqual(launch.resolve_bind_host(None), "127.0.0.1")
            self.assertTrue(launch.is_loopback_host(launch.resolve_bind_host(None)))

    def test_lan_and_all_are_spelled_out_for_convenience(self):
        for spelling in ("lan", "LAN", "all", "any"):
            self.assertEqual(launch.resolve_bind_host(spelling), "0.0.0.0")
        self.assertFalse(launch.is_loopback_host("0.0.0.0"))

    def test_an_explicit_interface_address_is_used_verbatim(self):
        self.assertEqual(launch.resolve_bind_host("192.168.1.50"), "192.168.1.50")

    def test_the_environment_variable_is_honoured(self):
        with patch.dict(os.environ, {"BOOKVOICE_HOST": "lan"}):
            self.assertEqual(launch.resolve_bind_host(None), "0.0.0.0")
        # An explicit argument wins over the environment.
        with patch.dict(os.environ, {"BOOKVOICE_HOST": "lan"}):
            self.assertEqual(launch.resolve_bind_host("127.0.0.1"), "127.0.0.1")


class NetworkEnvironmentTests(unittest.TestCase):
    def test_a_loopback_bind_changes_nothing(self):
        env = launch.apply_network_env({}, "127.0.0.1")
        self.assertNotIn("BOOKVOICE_ALLOW_PRIVATE_ORIGINS", env)
        self.assertNotIn("BOOKVOICE_COOKIE_SECURE", env)

    def test_a_lan_bind_admits_private_origins_and_plain_http_cookies(self):
        env = launch.apply_network_env({}, "0.0.0.0")
        self.assertEqual(env["BOOKVOICE_ALLOW_PRIVATE_ORIGINS"], "1")
        # Without this the Secure session cookie is discarded over plain HTTP.
        self.assertEqual(env["BOOKVOICE_COOKIE_SECURE"], "0")

    def test_an_explicit_operator_choice_is_never_overridden(self):
        env = launch.apply_network_env(
            {"BOOKVOICE_ALLOW_PRIVATE_ORIGINS": "0", "BOOKVOICE_COOKIE_SECURE": "1"},
            "0.0.0.0",
        )
        self.assertEqual(env["BOOKVOICE_ALLOW_PRIVATE_ORIGINS"], "0")
        self.assertEqual(env["BOOKVOICE_COOKIE_SECURE"], "1")


class PrivateOriginPolicyTests(unittest.TestCase):
    def test_lan_origins_are_refused_by_default(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BOOKVOICE_ALLOW_PRIVATE_ORIGINS", None)
            self.assertFalse(security.allow_private_origins())
            self.assertFalse(security.is_allowed_browser_origin("http://192.168.1.50:8000"))

    def test_lan_origins_are_accepted_once_enabled(self):
        with patch.dict(os.environ, {"BOOKVOICE_ALLOW_PRIVATE_ORIGINS": "1"}):
            for origin in (
                "http://192.168.1.50:8000",
                "http://10.0.0.4:8000",
                "http://172.16.5.9:8000",
                "http://hussam-laptop:8000",
                "http://hussam-laptop.local:8000",
            ):
                self.assertTrue(security.is_allowed_browser_origin(origin), origin)

    def test_public_addresses_stay_refused_even_when_enabled(self):
        with patch.dict(os.environ, {"BOOKVOICE_ALLOW_PRIVATE_ORIGINS": "1"}):
            self.assertFalse(security.is_allowed_browser_origin("https://example.com"))
            self.assertFalse(security.is_allowed_browser_origin("http://8.8.8.8"))
            self.assertFalse(security.is_allowed_browser_origin("http://evil.example.com"))

    def test_loopback_keeps_working_regardless(self):
        with patch.dict(os.environ, {"BOOKVOICE_ALLOW_PRIVATE_ORIGINS": "1"}):
            self.assertTrue(security.is_allowed_browser_origin("http://127.0.0.1:8000"))
        with patch.dict(os.environ, {"BOOKVOICE_ALLOW_PRIVATE_ORIGINS": "0"}):
            self.assertTrue(security.is_allowed_browser_origin("http://127.0.0.1:8000"))


class LauncherArgumentForwardingTests(unittest.TestCase):
    """`BookVoice.bat --host lan` has to actually reach launch.py."""

    def test_the_batch_launcher_forwards_extra_arguments(self):
        for script in (ROOT / "BookVoice.bat", ROOT / "dist" / "BookVoice.bat"):
            if not script.is_file():
                continue
            body = script.read_text(encoding="utf-8", errors="replace")
            invocation = next(
                line for line in body.splitlines()
                if "launch.py" in line and "--browser" in line
            )
            # Without %* the arguments are dropped silently, which looks like
            # the option not working rather than never arriving.
            self.assertIn("%*", invocation, f"{script.name} drops its arguments")

    def test_the_host_option_is_exposed_on_the_command_line(self):
        parser_source = (ROOT / "launch.py").read_text(encoding="utf-8", errors="replace")
        self.assertIn('"--host"', parser_source)


class LanAddressTests(unittest.TestCase):
    def test_discovery_never_reports_loopback_and_never_raises(self):
        addresses = launch.lan_addresses()
        self.assertIsInstance(addresses, list)
        for address in addresses:
            self.assertFalse(address.startswith("127."))


if __name__ == "__main__":
    unittest.main()
