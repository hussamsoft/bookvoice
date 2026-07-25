"""Browser-origin policy for the desktop API and for hosted deployments."""
from __future__ import annotations

import ipaddress
import os
from urllib.parse import urlparse


LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
_TRUTHY = {"1", "true", "yes", "on"}


def _normalize_origin(origin: str) -> str | None:
    """Return a bare scheme://host[:port] origin, or None when malformed."""
    try:
        parsed = urlparse(str(origin).strip())
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password:
        return None
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        return None
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    return f"{parsed.scheme}://{host}:{parsed.port}" if parsed.port else f"{parsed.scheme}://{host}"


def public_origins() -> set[str]:
    """Extra origins trusted in a hosted deployment.

    The desktop app leaves ``BOOKVOICE_PUBLIC_ORIGIN`` unset and keeps its
    loopback-only policy. A hosted deployment sets it to the exact origin the
    browser will use, e.g. ``https://bookvoice--app.modal.run``.
    """
    raw = os.environ.get("BOOKVOICE_PUBLIC_ORIGIN", "")
    allowed = set()
    for candidate in str(raw).replace(",", " ").split():
        normalized = _normalize_origin(candidate)
        if normalized:
            allowed.add(normalized)
    return allowed


def allow_private_origins() -> bool:
    """Whether browsers elsewhere on the local network may call the API.

    Off by default. The launcher turns it on when it is told to bind beyond
    loopback, because a phone on the same Wi-Fi reaches the app at a private
    address that changes with DHCP — enumerating exact origins would break the
    next time the lease renews.
    """
    return str(os.environ.get("BOOKVOICE_ALLOW_PRIVATE_ORIGINS", "")).strip().lower() in _TRUTHY


def _is_private_host(hostname: str) -> bool:
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        # Not an IP: accept mDNS names and single-label hostnames, which cannot
        # be registered on the public internet.
        name = hostname.lower().rstrip(".")
        return name.endswith(".local") or "." not in name
    return bool(address.is_private or address.is_link_local)


def is_allowed_browser_origin(origin: str | None) -> bool:
    """Allow native/non-browser requests, loopback browsers, and configured origins."""
    if origin is None or not origin.strip():
        return True
    normalized = _normalize_origin(origin)
    if normalized is None:
        return False
    parsed = urlparse(normalized)
    if parsed.hostname in LOOPBACK_HOSTS:
        return True
    if normalized in public_origins():
        return True
    return allow_private_origins() and _is_private_host(parsed.hostname or "")
