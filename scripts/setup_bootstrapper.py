#!/usr/bin/env python3
"""Download checksum-verified BookVoice MSI cabinets and start Windows Installer."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

REPOSITORY = "hussamsoft/bookvoice"


def _resolve_release_version() -> str:
    """Single-source the release version.

    Frozen launcher/setup executables read the ``version.txt`` staged beside
    them at build time; source runs read the repository's own ``VERSION``
    file. Nothing here may hardcode a version: a stale constant would make a
    freshly built exe reject its own release manifest.
    """
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
        for candidate in (base / "version.txt", base / "VERSION"):
            try:
                value = candidate.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if value:
                return value
        raise RuntimeError(
            "This BookVoice installer is missing its bundled version file. "
            "Please re-download it."
        )
    version_file = Path(__file__).resolve().parents[1] / "VERSION"
    try:
        value = version_file.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise RuntimeError("VERSION file was not found in the repository root.") from exc
    if not value:
        raise RuntimeError("VERSION file is empty.")
    return value


RELEASE_VERSION = _resolve_release_version()
DEFAULT_MANIFEST_URL = (
    f"https://github.com/{REPOSITORY}/releases/download/"
    f"v{RELEASE_VERSION}/release-assets.json"
)


class InstallCancelled(RuntimeError):
    """Raised when a cancel_event-driven install is aborted by the user."""


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


# Hard upper bound on any single asset. The manifest already pins the
# expected size, but a 2 GB asset on a compromised release would still
# pass checksum verification. Cap before downloading so a malformed
# manifest cannot exhaust disk or memory.
MAX_ASSET_BYTES = 1 * 1024 * 1024 * 1024

# Cap on the JSON manifest body itself; a 2 GB manifest payload would OOM
# urlopen(). The shipped manifest is well under 1 MiB.
MAX_MANIFEST_BYTES = 16 * 1024 * 1024

# Cap on HTTP 416 retry attempts; without a bound a broken mirror can
# recurse forever.
MAX_RESUME_RETRIES = 3

# Stable semver: digits, dots, optional pre-release/build suffix. Used to
# reject "2.7.0-rc.1" / "2.7.0-beta" pre-release tags.
STABLE_TAG = __import__("re").compile(r"^\d+\.\d+\.\d+$")


def download(url: str, target: Path, expected: dict, progress=None, cancel_event=None) -> None:
    """Download one asset with resume support and checksum enforcement.

    ``progress(received, total)`` fires after each chunk so GUI callers can
    drive a byte-level bar; the console entry point passes nothing.
    ``cancel_event`` aborts between chunks by raising
    :class:`InstallCancelled`, leaving any partial file in place so a later
    attempt resumes instead of restarting.

    Resume safety: a complete-size ``.part`` (crash between final write and
    rename) is verified and promoted directly instead of requesting a zero-length
    range, which servers answer with HTTP 416 — an error urllib surfaces as an
    exception, which previously deadlocked every retry until manual cleanup.
    Retries on HTTP 416 are bounded by ``MAX_RESUME_RETRIES`` to prevent an
    unbounded recursion if the server keeps returning 416.

    Size safety: any declared size above ``MAX_ASSET_BYTES`` is rejected
    before a single byte is read so a tampered manifest cannot pin a 2 GB
    blob through checksum verification.
    """

    declared = int(expected["size"])
    if declared <= 0 or declared > MAX_ASSET_BYTES:
        raise RuntimeError(
            f"Refusing to download {target.name}: declared size {declared} "
            f"is outside (0, {MAX_ASSET_BYTES}] bytes."
        )

    def _cancelled() -> bool:
        return cancel_event is not None and cancel_event.is_set()

    def _promote_complete_part(part: Path) -> bool:
        try:
            intact = (
                part.stat().st_size == declared
                and sha256(part) == expected["sha256"]
            )
        except OSError:
            intact = False
        if intact:
            os.replace(part, target)
            return True
        part.unlink(missing_ok=True)
        return False

    if _cancelled():
        raise InstallCancelled("The download was cancelled.")
    if target.suffix == ".part" or target.name.endswith(".part.part"):
        raise RuntimeError(
            f"Refusing to download into a .part path: {target.name}"
        )
    partial = target.with_suffix(target.suffix + ".part")
    total = declared

    received = partial.stat().st_size if partial.exists() else 0
    if received > total:
        partial.unlink(missing_ok=True)
        received = 0
    elif received == total:
        if _promote_complete_part(partial):
            return
        received = 0

    headers = {
        "Accept-Encoding": "identity",
        "User-Agent": f"BookVoice-Setup/{RELEASE_VERSION}",
    }
    if received:
        headers["Range"] = f"bytes={received}-"
    if progress:
        progress(min(received, total), total)

    resume_attempts = 0
    while True:
        try:
            response = urllib.request.urlopen(
                urllib.request.Request(url, headers=headers), timeout=60
            )
            break
        except urllib.error.HTTPError as error:
            if error.code == 416 and received and resume_attempts < MAX_RESUME_RETRIES:
                resume_attempts += 1
                partial.unlink(missing_ok=True)
                received = 0
                headers.pop("Range", None)
                continue
            raise

    with response:
        if received and getattr(response, "status", 206) != 206:
            received = 0
            partial.unlink(missing_ok=True)
        with partial.open("ab" if received else "wb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                # Hard cap on bytes received; refuse to grow the partial
                # beyond MAX_ASSET_BYTES even if the server streams more.
                if received + len(chunk) > MAX_ASSET_BYTES:
                    raise RuntimeError(
                        f"Aborting {target.name}: response exceeded {MAX_ASSET_BYTES} bytes."
                    )
                output.write(chunk)
                received += len(chunk)
                if progress:
                    progress(min(received, total), total)
                if _cancelled():
                    raise InstallCancelled("The download was cancelled.")

    if partial.stat().st_size != total or sha256(partial) != expected["sha256"]:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Checksum verification failed for {target.name}")
    os.replace(partial, target)


def fetch_manifest(manifest_url: str) -> dict:
    with urllib.request.urlopen(manifest_url, timeout=30) as response:
        # Cap the body so a multi-GB response cannot OOM the JSON parser.
        if response.length is not None and response.length > MAX_MANIFEST_BYTES:
            raise RuntimeError(
                f"Manifest payload {response.length} bytes exceeds "
                f"limit of {MAX_MANIFEST_BYTES}."
            )
        return json.load(response)


def resolve_latest_tag() -> str:
    """Ask GitHub for the newest release tag.

    DEFAULT_MANIFEST_URL is pinned to the version frozen into this executable,
    which is right for the installer that ships beside a release but means an
    older Setup.exe reinstalls its own old version instead of the current one.
    --latest is the opt-in escape from that pin.
    """
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPOSITORY}/releases/latest",
        headers={
            "User-Agent": f"BookVoice-Setup/{RELEASE_VERSION}",
            "Accept": "application/vnd.github+json",
            "Accept-Encoding": "identity",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    tag = str(payload.get("tag_name") or "").strip()
    if not tag:
        raise RuntimeError("The GitHub release response carried no tag.")
    bare = tag.lstrip("vV")
    if not STABLE_TAG.match(bare):
        raise RuntimeError(
            f"Refusing pre-release tag {tag!r}: --latest only installs stable releases."
        )
    return tag


def validate_manifest(manifest: dict, expected_version: str | None = None) -> None:
    version = expected_version or RELEASE_VERSION
    if (
        manifest.get("repository") != REPOSITORY
        or manifest.get("schemaVersion") != 1
        or manifest.get("version") != version
        or manifest.get("tag") != f"v{version}"
    ):
        raise RuntimeError("The BookVoice release manifest is not trusted.")


def plan_assets(manifest: dict, product: str) -> tuple[Path, list[str]]:
    """Return (download directory, asset names) for one install scope."""
    selected = manifest["products"][product]
    names = [selected["msi"], *selected["cabinets"]]
    for name in names:
        if not name or Path(name).name != name or name in (".", ".."):
            raise RuntimeError("The BookVoice release manifest contains an unsafe asset name.")
    required = sum(int(manifest["assets"][name]["size"]) for name in names)
    target = Path(tempfile.gettempdir()) / "BookVoice" / manifest["version"] / product
    target.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(target).free < required * 2:
        raise RuntimeError("Not enough free disk space for the offline BookVoice runtime.")
    return target, names


def ensure_files(manifest: dict, base_url: str, product: str, progress=None, cancel_event=None) -> Path:
    """Download and checksum-verify every asset; returns the download dir.

    ``progress(event)`` receives dict events describing overall progress:

    * ``{"kind": "plan", "files": n, "bytes": total}`` once, after planning
    * ``{"kind": "file", "name": str, "index": i, "count": n}`` per file
    * ``{"kind": "bytes", "name": str, "received": int, "size": int}``

    ``cancel_event`` aborts with :class:`InstallCancelled`, keeping partial
    files for a resumable retry.
    """

    def _report(event: dict) -> None:
        if progress:
            progress(event)

    target, names = plan_assets(manifest, product)
    total_bytes = sum(int(manifest["assets"][name]["size"]) for name in names)
    _report({"kind": "plan", "files": len(names), "bytes": total_bytes})
    for index, name in enumerate(names, 1):
        path = target / name
        expected = manifest["assets"][name]
        if not (
            path.is_file()
            and path.stat().st_size == expected["size"]
            and sha256(path) == expected["sha256"]
        ):
            _report({"kind": "file", "name": name, "index": index, "count": len(names)})
            download(
                f"{base_url}/{name}",
                path,
                expected,
                progress=lambda received, size, _name=name: _report(
                    {"kind": "bytes", "name": _name, "received": received, "size": size}
                ),
                cancel_event=cancel_event,
            )
    return target


def run_installer(download_dir: Path, msi_name: str, quiet: bool) -> int:
    command = ["msiexec.exe", "/i", str(download_dir / msi_name)]
    if quiet:
        command.extend(["/qn", "/norestart"])
    return subprocess.run(
        command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="Install BookVoice")
    parser.add_argument("--machine", action="store_true", help="Install for all users (admin required)")
    parser.add_argument("--manifest-url")
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--quiet", action="store_true", help="Run Windows Installer without interactive UI")
    parser.add_argument(
        "--latest",
        action="store_true",
        help="Install the newest published release instead of this installer's own version",
    )
    args = parser.parse_args()
    # The version is resolved once on import so test harnesses and any
    # other importer see the same value the CLI uses; re-resolving here
    # would break ``module.RELEASE_VERSION`` equality checks downstream.
    product = "machine" if args.machine else "user"
    expected_version = None
    if args.latest and not args.manifest_url:
        tag = resolve_latest_tag()
        expected_version = tag.lstrip("vV")
        manifest_url = (
            f"https://github.com/{REPOSITORY}/releases/download/{tag}/release-assets.json"
        )
    else:
        manifest_url = args.manifest_url or DEFAULT_MANIFEST_URL
    manifest = fetch_manifest(manifest_url)
    validate_manifest(manifest, expected_version)
    base = manifest_url.rsplit("/", 1)[0]
    target = ensure_files(manifest, base, product)
    if not args.download_only:
        return run_installer(target, manifest["products"][product]["msi"], args.quiet)
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
