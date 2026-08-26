"""Optional password gate for hosted BookVoice deployments.

The desktop app binds to loopback and needs no login, so this module is inert
unless ``BOOKVOICE_ACCESS_PASSWORD`` is set. When it is set, every API request
must carry a signed session cookie obtained by posting the password.

The signing key is derived from the password itself unless
``BOOKVOICE_SECRET_KEY`` is provided, so changing the password invalidates every
outstanding session without any server-side session store.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import threading
import time


COOKIE_NAME = "bookvoice_session"
SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
_MIN_PASSWORD_LENGTH = 8
_LOGIN_MAX_FAILURES = 5
_LOGIN_BACKOFF_SECONDS = 30
# address -> (consecutive failures, backoff deadline). In-memory by design:
# single-tenant process, and a restart clears the throttle.
_login_failures: dict[str, tuple[int, float]] = {}
_login_lock = threading.Lock()


def configured_password() -> str | None:
    value = os.environ.get("BOOKVOICE_ACCESS_PASSWORD", "")
    return value if value else None


def auth_required() -> bool:
    return configured_password() is not None


def server_mode() -> bool:
    """True when running as a hosted server rather than the desktop app.

    Windows-only conveniences (saving into the Downloads folder, opening a
    project folder in Explorer) are meaningless on a server, so the UI hides
    them instead of offering actions that would silently write somewhere the
    person can never reach.
    """
    return str(os.environ.get("BOOKVOICE_SERVER_MODE", "")).strip().lower() in {
        "1", "true", "yes", "on",
    }


def password_error(password: str | None) -> str | None:
    """Validate a candidate password for configuration, not for login."""
    if not password:
        return "An access password is required."
    if len(password) < _MIN_PASSWORD_LENGTH:
        return f"The access password must be at least {_MIN_PASSWORD_LENGTH} characters."
    return None


def _signing_key() -> bytes:
    explicit = os.environ.get("BOOKVOICE_SECRET_KEY", "")
    if explicit:
        return hashlib.sha256(explicit.encode("utf-8")).digest()
    password = configured_password() or ""
    return hashlib.sha256(f"bookvoice-session\0{password}".encode("utf-8")).digest()


def _sign(payload: bytes) -> str:
    digest = hmac.new(_signing_key(), payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def verify_password(candidate: str | None) -> bool:
    expected = configured_password()
    if expected is None:
        return True
    return hmac.compare_digest(str(candidate or "").encode("utf-8"), expected.encode("utf-8"))


def issue_session(now: float | None = None) -> str:
    """Return a signed, self-contained session token."""
    expires = int((now if now is not None else time.time()) + SESSION_TTL_SECONDS)
    payload = str(expires).encode("ascii")
    return f"{expires}.{_sign(payload)}"


def is_valid_session(token: str | None, now: float | None = None) -> bool:
    if not auth_required():
        return True
    raw = str(token or "")
    expires_text, _, signature = raw.partition(".")
    if not expires_text or not signature:
        return False
    try:
        expires = int(expires_text)
    except ValueError:
        return False
    if expires <= (now if now is not None else time.time()):
        return False
    return hmac.compare_digest(signature, _sign(expires_text.encode("ascii")))


def login_blocked_seconds(key: str) -> int:
    """Seconds left in the current login backoff window for this address."""
    with _login_lock:
        count, deadline = _login_failures.get(key, (0, 0.0))
        remaining = deadline - time.time()
        if count >= _LOGIN_MAX_FAILURES and remaining > 0:
            return int(remaining) + 1
        return 0


def record_login_failure(key: str) -> int:
    """Count a failed attempt; return the backoff now in effect (0 = none).

    Backoff grows by one window per additional failure past the threshold,
    so sustained guessing is slowed linearly rather than blocked forever.
    """
    now = time.time()
    with _login_lock:
        count, deadline = _login_failures.get(key, (0, 0.0))
        if deadline and deadline < now:
            count = 0
        count += 1
        backoff = 0
        deadline = 0.0
        if count >= _LOGIN_MAX_FAILURES:
            backoff = _LOGIN_BACKOFF_SECONDS * (count - _LOGIN_MAX_FAILURES + 1)
            deadline = now + backoff
        _login_failures[key] = (count, deadline)
    return backoff


def record_login_success(key: str) -> None:
    with _login_lock:
        _login_failures.pop(key, None)


# Reachable without a session: the gate itself, and the readiness probe the
# launcher polls before any UI (and therefore any login) exists.
PUBLIC_API_PREFIXES = ("/api/access", "/api/health")


def requires_session(path: str) -> bool:
    """True when a request path must present a valid session cookie."""
    if not auth_required():
        return False
    target = str(path or "")
    if target.startswith(PUBLIC_API_PREFIXES):
        return False
    # Generated audio is served straight off /sessions, so it is gated too.
    return target.startswith("/api/") or target.startswith("/sessions/")


def capabilities() -> dict:
    """Runtime capability flags the UI uses to hide unavailable actions."""
    hosted = server_mode()
    return {
        "serverMode": hosted,
        "localFileActions": not hosted and os.name == "nt",
        "authRequired": auth_required(),
    }
