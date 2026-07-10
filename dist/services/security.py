"""Browser-origin policy for the localhost desktop API."""
from __future__ import annotations

from urllib.parse import urlparse


def is_allowed_browser_origin(origin: str | None) -> bool:
    """Allow native/non-browser requests and HTTP(S) loopback browser origins."""
    if origin is None or not origin.strip():
        return True
    try:
        parsed = urlparse(origin.strip())
    except ValueError:
        return False
    return (
        parsed.scheme in {"http", "https"}
        and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        and not parsed.username
        and not parsed.password
        and parsed.path in {"", "/"}
        and not parsed.query
        and not parsed.fragment
    )
