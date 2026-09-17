#!/usr/bin/env python3
"""One-time bootstrapper for vendored third-party bundles.

Usage:
    python scripts/vendor/fetch.py axe-core

Re-downloads the axe-core minified bundle to ``scripts/vendor/axe.min.js``
and updates the SHA256 next to it. After running, ``scripts/audit_a11y.py``
will pick the vendored copy automatically and refuse to run if the hash
ever drifts from the pinned value.

Network is required only the first time; subsequent audits run offline.
"""
from __future__ import annotations

import hashlib
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from axe import (  # noqa: E402  - import after sys.path tweak
    AXE_SHA256,
    AXE_SOURCE_URL,
    VENDOR_DIR,
    expected_hash_path,
    expected_path,
    write_hash_file,
)


def fetch_bytes(url: str, *, timeout: float = 30.0, max_bytes: int = 8 * 1024 * 1024) -> bytes:
    """Fetch ``url`` with a hard size cap so a CDN compromise cannot OOM us."""
    request = urllib.request.Request(url, headers={"User-Agent": "bookvoice-vendor/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content_length = response.headers.get("Content-Length")
        if content_length and content_length.isdigit() and int(content_length) > max_bytes:
            raise RuntimeError(
                f"Refusing to fetch {url}: Content-Length {content_length} exceeds {max_bytes} bytes."
            )
        chunks = bytearray()
        while True:
            block = response.read(64 * 1024)
            if not block:
                break
            chunks.extend(block)
            if len(chunks) > max_bytes:
                raise RuntimeError(
                    f"Refusing to fetch {url}: response exceeded {max_bytes} bytes."
                )
    return bytes(chunks)


def fetch_axe() -> None:
    print(f"Fetching {AXE_SOURCE_URL}")
    payload = fetch_bytes(AXE_SOURCE_URL)
    digest = hashlib.sha256(payload).hexdigest()
    if digest != AXE_SHA256:
        raise SystemExit(
            "Downloaded axe-core does not match the pinned SHA256.\n"
            f"  expected: {AXE_SHA256}\n"
            f"  actual:   {digest}\n"
            "If this was a deliberate bump, update AXE_VERSION and AXE_SHA256 in scripts/vendor/axe.py."
        )
    expected_path().write_bytes(payload)
    write_hash_file()
    print(f"Wrote {expected_path()} ({len(payload)} bytes)")
    print(f"SHA256: {digest}")


COMMANDS = {
    "axe-core": fetch_axe,
}


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] not in COMMANDS:
        print(__doc__)
        return 2
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    try:
        COMMANDS[argv[1]]()
    except urllib.error.URLError as exc:
        raise SystemExit(f"Network error fetching vendor bundle: {exc}") from exc
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
