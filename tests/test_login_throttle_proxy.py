"""Regression test for the login throttle "unknown" bucket bypass (C-25).

Before the fix, throttle_key returned f"direct:{client_host or 'unknown'}"
whenever client_host was empty. With BOOKVOICE_TRUST_PROXY_HEADERS=true
and a missing X-Forwarded-For, every client behind the trusted proxy
shared one throttle bucket; one guesser could lock them all out.

After the fix, when trust_proxy_headers=True and no X-Forwarded-For is
supplied, the throttle key is "proxy:missing-x-forwarded-for" (a
global bucket the operator is expected to monitor), not a per-peer
"unknown" key. Operators can opt back into per-peer bucketing with
BOOKVOICE_LOGIN_TRUST_REMOTE_DIRECT=true.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


class LoginThrottleProxyBypassTests(unittest.TestCase):
    def setUp(self) -> None:
        # Ensure BOOKVOICE_LOGIN_TRUST_REMOTE_DIRECT is not set.
        self._saved = os.environ.get("BOOKVOICE_LOGIN_TRUST_REMOTE_DIRECT")
        os.environ.pop("BOOKVOICE_LOGIN_TRUST_REMOTE_DIRECT", None)

    def tearDown(self) -> None:
        if self._saved is None:
            os.environ.pop("BOOKVOICE_LOGIN_TRUST_REMOTE_DIRECT", None)
        else:
            os.environ["BOOKVOICE_LOGIN_TRUST_REMOTE_DIRECT"] = self._saved

    def test_proxy_no_xff_does_not_fall_back_to_unknown_per_peer(self) -> None:
        """With trust on and no XFF, every client gets the same global key."""
        from services import access_service

        k1 = access_service.throttle_key("", "", trust_proxy_headers=True)
        k2 = access_service.throttle_key("10.0.0.1", "", trust_proxy_headers=True)
        k3 = access_service.throttle_key("10.0.0.99", "", trust_proxy_headers=True)
        # All three converge on the missing-XFF bucket, not the per-peer
        # "direct:unknown" that the bug allowed.
        self.assertEqual(k1, "proxy:missing-x-forwarded-for")
        self.assertEqual(k2, "proxy:missing-x-forwarded-for")
        self.assertEqual(k3, "proxy:missing-x-forwarded-for")
        self.assertNotIn("unknown", k1)

    def test_proxy_with_xff_uses_proxy_key(self) -> None:
        """A real XFF still yields per-client proxy keys."""
        from services import access_service

        k1 = access_service.throttle_key("", "203.0.113.1", trust_proxy_headers=True)
        k2 = access_service.throttle_key("", "203.0.113.2", trust_proxy_headers=True)
        self.assertEqual(k1, "proxy:203.0.113.1")
        self.assertEqual(k2, "proxy:203.0.113.2")
        self.assertNotEqual(k1, k2)

    def test_proxy_with_xff_comma_list_takes_first(self) -> None:
        """Multiple XFF entries: first wins."""
        from services import access_service

        k = access_service.throttle_key(
            "", "198.51.100.5, 198.51.100.6", trust_proxy_headers=True
        )
        self.assertEqual(k, "proxy:198.51.100.5")

    def test_trust_remote_direct_opt_in_restores_per_peer(self) -> None:
        """BOOKVOICE_LOGIN_TRUST_REMOTE_DIRECT=1 gives per-peer bucketing."""
        from services import access_service

        os.environ["BOOKVOICE_LOGIN_TRUST_REMOTE_DIRECT"] = "1"
        k = access_service.throttle_key("10.0.0.1", "", trust_proxy_headers=True)
        self.assertEqual(k, "direct:10.0.0.1")

    def test_no_proxy_trust_uses_direct_key(self) -> None:
        """Without trust_proxy_headers, behaviour is unchanged."""
        from services import access_service

        k = access_service.throttle_key("127.0.0.1", "", trust_proxy_headers=False)
        self.assertEqual(k, "direct:127.0.0.1")


if __name__ == "__main__":
    unittest.main()
