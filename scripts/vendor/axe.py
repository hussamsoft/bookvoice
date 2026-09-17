"""Vendor pinned third-party JS bundles for offline use.

Each entry below is fetched once at setup time and pinned by SHA256. The
accessibility audit (``scripts/audit_a11y.py``) refuses to run if the hash
mismatches the pinned value, so a CDN tamper or downgrade cannot silently
turn a real audit green.

Update workflow:
  1. Bump ``VERSION`` below.
  2. Run ``python scripts/vendor/fetch.py axe-core`` to re-download and
     rewrite the hash file.
  3. Commit the new ``*.min.js`` and ``*.sha256`` pair.

The pinned hashes are recorded alongside each library below.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

VENDOR_DIR = Path(__file__).resolve().parent

# Pinned versions; bumping requires re-running ``fetch.py``.
AXE_VERSION = "4.10.0"

# SHA256 of the vendored axe-core minified bundle. Recompute with
# ``scripts/vendor/fetch.py axe-core`` after a deliberate bump; do not edit
# by hand.
AXE_SHA256 = (
    "483a4fed4b2fe56cfd94a58565020c863983f8415e2827f3481dce35e70effb5"
)

# Public source so the auditor can confirm what was downloaded.
AXE_SOURCE_URL = (
    f"https://cdnjs.cloudflare.com/ajax/libs/axe-core/{AXE_VERSION}/axe.min.js"
)


def expected_path() -> Path:
    return VENDOR_DIR / f"axe.min.js"


def expected_hash_path() -> Path:
    return VENDOR_DIR / f"axe.min.js.sha256"


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify_axe(payload: bytes) -> str:
    """Return the SHA256 of ``payload`` if it matches the pinned value.

    Raises ``RuntimeError`` if the bytes are missing, empty, or have been
    tampered with. The auditor treats a mismatch as a hard failure so a
    compromised CDN cannot silently downgrade the rule set.
    """
    if not payload:
        raise RuntimeError(
            "axe-core vendor bundle is empty; run scripts/vendor/fetch.py axe-core."
        )
    digest = _sha256_bytes(payload)
    if digest != AXE_SHA256:
        raise RuntimeError(
            "axe-core SHA256 mismatch.\n"
            f"  expected: {AXE_SHA256}\n"
            f"  actual:   {digest}\n"
            "Re-run scripts/vendor/fetch.py axe-core after a deliberate bump."
        )
    return digest


def write_hash_file() -> None:
    """Persist the pinned SHA256 next to the bundle for human review."""
    path = expected_path()
    if not path.exists():
        raise RuntimeError(
            f"axe-core bundle is missing at {path}; run fetch.py axe-core."
        )
    payload = path.read_bytes()
    digest = _sha256_bytes(payload)
    if digest != AXE_SHA256:
        raise RuntimeError(
            f"axe-core hash mismatch while writing {expected_hash_path()}."
        )
    expected_hash_path().write_text(digest + "\n", encoding="ascii")
