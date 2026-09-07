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


def _request_host_is_loopbackish(host_header: str) -> bool:
    """Whether Host names this machine's own loopback interface.

    The browser reaching the desktop app always addresses loopback (or the
    machine's own LAN address in --host lan mode), so a Host that is not one
    of those cannot be this server being addressed directly. Comparing
    attacker-controlled Host against Origin is what made DNS rebinding
    possible; only Host values we would bind to ourselves count here.
    """
    host = str(host_header or "").strip()
    if not host:
        return False
    # Strip any port before comparing: "[::1]:8000" -> "::1".
    if host.startswith("["):
        candidate = host[1:].split("]", 1)[0]
    else:
        candidate = host.split(":")[0]
    candidate = candidate.strip().lower().rstrip(".")
    if candidate in LOOPBACK_HOSTS:
        return True
    # A LAN bind is still this machine; a public hostname never is.
    return allow_private_origins() and _is_private_host(candidate)


def _matches_request_origin(
    normalized_origin: str,
    *,
    request_scheme: str = "",
    request_host: str = "",
    forwarded_proto: str = "",
    trust_proxy_headers: bool = False,
) -> bool:
    """Return whether Origin is the same origin that received the request.

    Only direct loopback (or LAN, when deliberately bound beyond loopback)
    requests qualify. ``X-Forwarded-Proto`` is honored only when the caller
    says a trusted proxy set it: on an open port any client can forge the
    header, and trusting it would let a plain-HTTP attacker claim HTTPS.
    Hosted deployments behind a proxy must authenticate at the gate and list
    their exact browser origin in ``BOOKVOICE_PUBLIC_ORIGIN`` instead.
    """
    if not _request_host_is_loopbackish(request_host):
        return False
    parsed = urlparse(normalized_origin)
    request_host_part = str(request_host or "").strip().lower()
    if request_host_part.startswith("["):
        request_host_part = request_host_part[1:].split("]", 1)[0]
    else:
        request_host_part = request_host_part.split(":")[0]
    if (parsed.hostname or "").lower() != request_host_part.rstrip("."):
        return False
    schemes = []
    if trust_proxy_headers:
        forwarded = str(forwarded_proto or "").split(",", 1)[0].strip().lower()
        if forwarded in {"http", "https"}:
            schemes.append(forwarded)
    direct = str(request_scheme or "").strip().lower()
    if direct in {"http", "https"} and direct not in schemes:
        schemes.append(direct)
    return parsed.scheme in schemes

def is_allowed_browser_origin(
    origin: str | None,
    *,
    request_scheme: str = "",
    request_host: str = "",
    forwarded_proto: str = "",
    trust_proxy_headers: bool = False,
) -> bool:
    """Allow native requests, same-origin browsers, and configured origins."""
    if origin is None or not origin.strip():
        return True
    normalized = _normalize_origin(origin)
    if normalized is None:
        return False
    parsed = urlparse(normalized)
    if parsed.hostname in LOOPBACK_HOSTS:
        # A loopback Origin is only same-origin when the request actually
        # arrived on loopback. Otherwise any rebinding domain that resolves
        # to 127.0.0.1 could mint a trusted Origin for this server.
        return _request_host_is_loopbackish(request_host)
    if _matches_request_origin(
        normalized,
        request_scheme=request_scheme,
        request_host=request_host,
        forwarded_proto=forwarded_proto,
        trust_proxy_headers=trust_proxy_headers,
    ):
        return True
    if normalized in public_origins():
        return True
    return allow_private_origins() and _is_private_host(parsed.hostname or "")
