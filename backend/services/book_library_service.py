"""Persistent prepared-book library and safe .bookvoice archives."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import struct
import tempfile
import threading
import time
import uuid
import zipfile
from concurrent.futures import CancelledError
from pathlib import Path, PurePosixPath

from services.config_service import app_version
from services.path_utils import validate_language_id, validate_page_index, validate_voice_id

SCHEMA_VERSION = 1
MAX_ARCHIVE_ENTRIES = 20_000
MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024
MAX_ARCHIVE_METADATA_BYTES = 4 * 1024 * 1024
MAX_ARCHIVE_SOURCE_BYTES = 2 * 1024 * 1024 * 1024
FILE_CHUNK_BYTES = 1024 * 1024
PREPARATION_STATES = {"QUEUED", "RUNNING", "PAUSED", "COMPLETED", "CANCELLED", "FAILED"}
LEGACY_WAV_VALIDATION_ERROR = "Prepared narration is not a valid WAV file."

_lock = threading.RLock()
_jobs: dict[str, dict] = {}
_archives: dict[str, dict] = {}


def library_root() -> Path:
    root = Path(os.environ.get("DATA_DIR", "data")) / "library"
    root.mkdir(parents=True, exist_ok=True)
    return root


def book_dir(book_id: str) -> Path:
    if not book_id or len(book_id) != 64 or any(c not in "0123456789abcdef" for c in book_id):
        raise ValueError("Invalid book id.")
    return library_root() / book_id


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_wav_bytes(payload: bytes) -> None:
    if len(payload) < 44 or payload[:4] != b"RIFF" or payload[8:12] != b"WAVE":
        raise ValueError("Prepared narration is not a valid WAV file.")
    declared_size = struct.unpack_from("<I", payload, 4)[0] + 8
    if declared_size > len(payload):
        raise ValueError("Prepared narration is not a valid WAV file.")

    format_valid = False
    data_valid = False
    offset = 12
    while offset + 8 <= len(payload):
        chunk_id = payload[offset : offset + 4]
        chunk_size = struct.unpack_from("<I", payload, offset + 4)[0]
        chunk_start = offset + 8
        chunk_end = chunk_start + chunk_size
        if chunk_end > len(payload):
            raise ValueError("Prepared narration is not a valid WAV file.")
        if chunk_id == b"fmt ":
            if chunk_size < 16:
                raise ValueError("Prepared narration is not a valid WAV file.")
            audio_format, channels, sample_rate, _, block_align, bits = struct.unpack_from(
                "<HHIIHH", payload, chunk_start
            )
            format_valid = (
                audio_format in {1, 3, 0xFFFE}
                and 1 <= channels <= 32
                and sample_rate > 0
                and block_align > 0
                and bits in {8, 16, 24, 32, 64}
            )
        elif chunk_id == b"data":
            data_valid = chunk_size > 0
        offset = chunk_end + (chunk_size & 1)

    if not format_valid or not data_valid:
        raise ValueError("Prepared narration is not a valid WAV file.")


def _validate_wav_file(path: Path) -> None:
    """Validate WAV structure without loading the audio payload into memory."""
    file_size = path.stat().st_size
    if file_size < 44:
        raise ValueError("Prepared narration is not a valid WAV file.")

    format_valid = False
    data_valid = False
    with path.open("rb") as handle:
        header = handle.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise ValueError("Prepared narration is not a valid WAV file.")
        declared_size = struct.unpack_from("<I", header, 4)[0] + 8
        if declared_size > file_size:
            raise ValueError("Prepared narration is not a valid WAV file.")

        offset = 12
        while offset + 8 <= declared_size:
            handle.seek(offset)
            chunk_header = handle.read(8)
            if len(chunk_header) != 8:
                raise ValueError("Prepared narration is not a valid WAV file.")
            chunk_id = chunk_header[:4]
            chunk_size = struct.unpack_from("<I", chunk_header, 4)[0]
            chunk_start = offset + 8
            chunk_end = chunk_start + chunk_size
            if chunk_end > declared_size or chunk_end > file_size:
                raise ValueError("Prepared narration is not a valid WAV file.")
            if chunk_id == b"fmt ":
                if chunk_size < 16:
                    raise ValueError("Prepared narration is not a valid WAV file.")
                handle.seek(chunk_start)
                fmt = handle.read(16)
                if len(fmt) != 16:
                    raise ValueError("Prepared narration is not a valid WAV file.")
                audio_format, channels, sample_rate, _, block_align, bits = struct.unpack(
                    "<HHIIHH", fmt
                )
                format_valid = (
                    audio_format in {1, 3, 0xFFFE}
                    and 1 <= channels <= 32
                    and sample_rate > 0
                    and block_align > 0
                    and bits in {8, 16, 24, 32, 64}
                )
            elif chunk_id == b"data":
                data_valid = chunk_size > 0
            offset = chunk_end + (chunk_size & 1)

    if not format_valid or not data_valid:
        raise ValueError("Prepared narration is not a valid WAV file.")


def page_audio_path(book_id: str, profile: str, page: int) -> Path:
    if len(str(profile or "")) != 20 or any(c not in "0123456789abcdef" for c in str(profile)):
        raise ValueError("Invalid narration profile id.")
    return book_dir(book_id) / "audio" / profile / f"page-{validate_page_index(page)}.wav"


def has_valid_page_audio(book_id: str, profile: str, page: int) -> bool:
    path = page_audio_path(book_id, profile, page)
    try:
        _validate_wav_file(path)
    except (OSError, ValueError):
        return False
    return True


def is_page_prepared(book_id: str, profile: str, page: int, metadata: dict | None = None) -> bool:
    try:
        page_meta = metadata if metadata is not None else get_page(book_id, page)
    except (ValueError, FileNotFoundError):
        return False
    return prepared_audio_metadata(book_id, profile, page, page_meta) is not None


def prepared_audio_metadata(
    book_id: str,
    profile: str,
    page: int,
    metadata: dict | None = None,
) -> dict | None:
    """Resolve profile audio from page metadata or the authoritative manifest.

    Early v1 archives can contain valid profile audio/checksums without the
    optional page-level ``audio`` pointer. The manifest supports multiple
    profiles, while that legacy pointer can describe only one, so it cannot be
    the sole readiness source.
    """
    page = validate_page_index(page)
    page_meta = metadata if isinstance(metadata, dict) else get_page(book_id, page)
    audio = page_meta.get("audio") if isinstance(page_meta, dict) else None
    if isinstance(audio, dict) and audio.get("profileId") == profile:
        if has_valid_page_audio(book_id, profile, page):
            return dict(audio)
        return None

    manifest = _read_json(_manifest_path(book_id))
    profile_record = (manifest.get("profiles") or {}).get(profile)
    checksum_key = f"audio/{profile}/page-{page}.wav"
    checksum = (manifest.get("audioChecksums") or {}).get(checksum_key)
    completed = profile_record.get("completedPages", []) if isinstance(profile_record, dict) else []
    if page not in {int(value) for value in completed if str(value).isdigit()}:
        return None
    if not checksum or not has_valid_page_audio(book_id, profile, page):
        return None
    return {
        "profileId": profile,
        "path": checksum_key,
        "sha256": checksum,
        "duration": 0.0,
    }


def _manifest_path(book_id: str) -> Path:
    return book_dir(book_id) / "manifest.json"


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _read_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FileNotFoundError(f"Prepared-book metadata is unavailable: {path.name}") from exc
    if not isinstance(payload, dict):
        raise ValueError("Prepared-book metadata must be an object.")
    return payload


def _new_manifest(book_id: str, title: str, source_hash: str) -> dict:
    now = int(time.time())
    return {
        "schemaVersion": SCHEMA_VERSION,
        "id": book_id,
        "title": title or "Untitled book",
        "sourceSha256": source_hash,
        "pageCount": 0,
        "createdAt": now,
        "updatedAt": now,
        "progress": {"page": 1, "time": 0, "bookmarks": [], "updatedAt": now},
        "profiles": {},
        "preparation": None,
    }


def import_pdf(payload: bytes, filename: str) -> dict:
    if not payload.startswith(b"%PDF"):
        raise ValueError("The selected file is not a PDF.")
    book_id = _sha256_bytes(payload)
    target = book_dir(book_id)
    target.mkdir(parents=True, exist_ok=True)
    source = target / "source.pdf"
    if not source.exists() or _sha256_file(source) != book_id:
        source.write_bytes(payload)
    manifest_path = target / "manifest.json"
    if manifest_path.exists():
        manifest = _read_json(manifest_path)
    else:
        title = Path(filename or "Untitled book").stem
        manifest = _new_manifest(book_id, title, book_id)
        _write_json(manifest_path, manifest)
    return _summary(manifest)


def import_pdf_path(path: Path, filename: str) -> dict:
    """Import a staged PDF using bounded disk I/O instead of a whole-file buffer."""
    source_path = Path(path)
    with source_path.open("rb") as handle:
        if handle.read(4) != b"%PDF":
            raise ValueError("The selected file is not a PDF.")
    book_id = _sha256_file(source_path)
    target = book_dir(book_id)
    target.mkdir(parents=True, exist_ok=True)
    source = target / "source.pdf"
    if not source.exists() or _sha256_file(source) != book_id:
        fd, temp_name = tempfile.mkstemp(prefix=".source-", suffix=".pdf", dir=target)
        os.close(fd)
        try:
            shutil.copy2(source_path, temp_name)
            os.replace(temp_name, source)
        except Exception:
            Path(temp_name).unlink(missing_ok=True)
            raise
    manifest_path = target / "manifest.json"
    if manifest_path.exists():
        manifest = _read_json(manifest_path)
    else:
        title = Path(filename or "Untitled book").stem
        manifest = _new_manifest(book_id, title, book_id)
        _write_json(manifest_path, manifest)
    return _summary(manifest)


def _summary(manifest: dict) -> dict:
    profiles = manifest.get("profiles") if isinstance(manifest.get("profiles"), dict) else {}
    summarized_profiles = []
    for profile_id, profile_record in profiles.items():
        if not isinstance(profile_record, dict):
            continue
        ready_pages = []
        for value in profile_record.get("completedPages", []):
            try:
                page = int(value)
                checksum_key = f"audio/{profile_id}/page-{page}.wav"
                if (manifest.get("audioChecksums") or {}).get(checksum_key) and has_valid_page_audio(
                    manifest["id"], profile_id, page
                ):
                    ready_pages.append(page)
            except (TypeError, ValueError):
                continue
        summarized_profiles.append(
            {**profile_record, "readyPages": sorted(set(ready_pages))}
        )
    return {
        "id": manifest["id"],
        "title": manifest.get("title") or "Untitled book",
        "pageCount": int(manifest.get("pageCount") or 0),
        "sourceSha256": manifest.get("sourceSha256"),
        "updatedAt": manifest.get("updatedAt"),
        "progress": manifest.get("progress") or {},
        "profiles": summarized_profiles,
        "activeProfileId": manifest.get("activeProfileId"),
        "preparation": manifest.get("preparation"),
    }


def list_books() -> list[dict]:
    books = []
    for manifest_path in library_root().glob("*/manifest.json"):
        try:
            books.append(_summary(get_book(manifest_path.parent.name)))
        except (ValueError, FileNotFoundError, KeyError):
            continue
    return sorted(books, key=lambda item: item.get("updatedAt") or 0, reverse=True)


def get_book(book_id: str) -> dict:
    manifest = _read_json(_manifest_path(book_id))
    preparation = manifest.get("preparation") or {}
    job_id = preparation.get("id")
    changed = False
    if preparation.get("status") in {"QUEUED", "RUNNING"} and job_id not in _jobs:
        preparation["status"] = "PAUSED"
        changed = True
    if (
        preparation.get("status") == "FAILED"
        and preparation.get("error") == LEGACY_WAV_VALIDATION_ERROR
        and not preparation.get("legacyWavRecoveryAttempted")
    ):
        preparation["status"] = "PAUSED"
        preparation["error"] = None
        preparation["legacyWavRecoveryAttempted"] = True
        changed = True
    if changed:
        manifest["preparation"] = preparation
        manifest["updatedAt"] = int(time.time())
        _write_json(_manifest_path(book_id), manifest)
    return manifest


def delete_book(book_id: str) -> None:
    target = book_dir(book_id)
    if target.exists():
        shutil.rmtree(target)


def save_page(book_id: str, page: int, text: str, page_count: int | None = None) -> dict:
    page = validate_page_index(page)
    if page < 1:
        raise ValueError("Page numbers start at 1.")
    clean = str(text or "").strip()
    if not clean:
        raise ValueError("Page text cannot be empty.")
    target = book_dir(book_id) / "pages" / f"{page}.json"
    existing = _read_json(target) if target.exists() else {}
    text_hash = _sha256_bytes(clean.encode("utf-8"))
    unchanged = existing.get("textSha256") == text_hash
    payload = {
        "page": page,
        "text": clean,
        "textSha256": text_hash,
        "wordTimings": (existing.get("wordTimings") or []) if unchanged else [],
        "updatedAt": int(time.time()),
    }
    if unchanged and existing.get("audio"):
        payload["audio"] = existing["audio"]
    _write_json(target, payload)
    with _lock:
        manifest = get_book(book_id)
        if not unchanged:
            for audio_path in (book_dir(book_id) / "audio").glob(f"*/page-{page}.wav"):
                try:
                    audio_path.unlink()
                except OSError:
                    pass
            for profile in (manifest.get("profiles") or {}).values():
                profile["completedPages"] = [
                    completed_page
                    for completed_page in profile.get("completedPages", [])
                    if int(completed_page) != page
                ]
            manifest["audioChecksums"] = {
                name: checksum
                for name, checksum in (manifest.get("audioChecksums") or {}).items()
                if not name.endswith(f"/page-{page}.wav")
            }
            preparation = manifest.get("preparation")
            if isinstance(preparation, dict) and preparation.get("status") == "COMPLETED":
                preparation["status"] = "PAUSED"
                preparation["completedPages"] = [
                    completed_page
                    for completed_page in preparation.get("completedPages", [])
                    if int(completed_page) != page
                ]
                preparation["error"] = None
        manifest["pageCount"] = max(int(manifest.get("pageCount") or 0), int(page_count or 0), page)
        manifest.setdefault("pageHashes", {})[f"{page}.json"] = _sha256_file(target)
        manifest["updatedAt"] = int(time.time())
        _write_json(_manifest_path(book_id), manifest)
    return payload


def get_page(book_id: str, page: int) -> dict:
    page = validate_page_index(page)
    return _read_json(book_dir(book_id) / "pages" / f"{page}.json")


def profile_id(voice_id: str | None, language_id: str, generation_settings: dict | None = None) -> str:
    language = validate_language_id(language_id)
    voice = validate_voice_id(voice_id) if voice_id else "default"
    settings = json.dumps(generation_settings or {}, sort_keys=True, separators=(",", ":"))
    identity = "\0".join((voice, language, app_version(), settings))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]


def mark_page_audio(
    book_id: str,
    profile: str,
    page: int,
    audio_source: Path,
    word_timings: list,
    duration: float,
    voice_id: str | None,
    language_id: str,
) -> dict:
    _validate_wav_file(audio_source)
    page_meta = get_page(book_id, page)
    target = page_audio_path(book_id, profile, page)
    target.parent.mkdir(parents=True, exist_ok=True)
    if audio_source.resolve() != target.resolve():
        shutil.copy2(audio_source, target)
    audio_sha256 = _sha256_file(target)
    page_meta["wordTimings"] = word_timings or []
    page_meta["audio"] = {
        "profileId": profile,
        "path": f"audio/{profile}/page-{page}.wav",
        "sha256": audio_sha256,
        "duration": float(duration or 0),
    }
    _write_json(book_dir(book_id) / "pages" / f"{page}.json", page_meta)
    with _lock:
        manifest = get_book(book_id)
        profiles = manifest.setdefault("profiles", {})
        record = profiles.setdefault(
            profile,
            {
                "id": profile,
                "voiceId": voice_id,
                "languageId": validate_language_id(language_id),
                "modelVersion": app_version(),
                "completedPages": [],
            },
        )
        record["completedPages"] = sorted(set(record.get("completedPages", [])) | {page})
        manifest["activeProfileId"] = profile
        manifest.setdefault("pageHashes", {})[f"{page}.json"] = _sha256_file(
            book_dir(book_id) / "pages" / f"{page}.json"
        )
        manifest.setdefault("audioChecksums", {})[
            f"audio/{profile}/page-{page}.wav"
        ] = audio_sha256
        manifest["updatedAt"] = int(time.time())
        _write_json(_manifest_path(book_id), manifest)
    return page_meta


def update_progress(book_id: str, progress: dict) -> dict:
    with _lock:
        manifest = get_book(book_id)
        current = manifest.get("progress") or {}
        incoming_time = int(progress.get("updatedAt") or time.time())
        if incoming_time >= int(current.get("updatedAt") or 0):
            manifest["progress"] = {
                "page": max(1, int(progress.get("page") or 1)),
                "time": max(0.0, float(progress.get("time") or 0)),
                "bookmarks": sorted(set(int(p) for p in progress.get("bookmarks", []) if int(p) > 0)),
                "updatedAt": incoming_time,
            }
            manifest["updatedAt"] = int(time.time())
            _write_json(_manifest_path(book_id), manifest)
        return manifest["progress"]


def _safe_archive_members(bundle: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    infos = bundle.infolist()
    if len(infos) > MAX_ARCHIVE_ENTRIES:
        raise ValueError("Prepared-book archive contains too many entries.")
    seen = set()
    total = 0
    for info in infos:
        name = info.filename.replace("\\", "/")
        path = PurePosixPath(name)
        if name in seen or path.is_absolute() or ".." in path.parts or not path.parts:
            raise ValueError("Prepared-book archive contains an unsafe or duplicate path.")
        seen.add(name)
        total += int(info.file_size)
        if total > MAX_ARCHIVE_BYTES:
            raise ValueError("Prepared-book archive is too large.")
        if (
            name == "manifest.json" or name.startswith("pages/")
        ) and int(info.file_size) > MAX_ARCHIVE_METADATA_BYTES:
            raise ValueError("Prepared-book metadata entry is too large.")
        if name == "document/source.pdf" and int(info.file_size) > MAX_ARCHIVE_SOURCE_BYTES:
            raise ValueError("Prepared-book source PDF is too large.")
        mode = (info.external_attr >> 16) & 0o170000
        if mode == 0o120000:
            raise ValueError("Prepared-book archive cannot contain symbolic links.")
    return infos


def create_archive(book_id: str, profile: str) -> dict:
    manifest = get_book(book_id)
    if profile not in (manifest.get("profiles") or {}):
        raise FileNotFoundError("Prepared narration profile was not found.")
    archive_id = uuid.uuid4().hex
    output_dir = Path(os.environ.get("DATA_DIR", "data")) / "book-archives"
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / f"{book_id[:12]}-{profile}.bookvoice"
    export_manifest = dict(manifest)
    export_manifest["profiles"] = {profile: manifest["profiles"][profile]}
    export_manifest["activeProfileId"] = profile
    page_paths = sorted((book_dir(book_id) / "pages").glob("*.json"))
    audio_dir = book_dir(book_id) / "audio" / profile
    audio_paths = sorted(audio_dir.glob("*.wav"))
    export_manifest["pageHashes"] = {
        page_path.name: _sha256_file(page_path) for page_path in page_paths
    }
    export_manifest["audioChecksums"] = {
        f"audio/{profile}/{audio_path.name}": _sha256_file(audio_path)
        for audio_path in audio_paths
    }
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as bundle:
        bundle.writestr("manifest.json", json.dumps(export_manifest, indent=2, ensure_ascii=False))
        bundle.write(book_dir(book_id) / "source.pdf", "document/source.pdf")
        for page_path in page_paths:
            bundle.write(page_path, f"pages/{page_path.name}")
        for audio_path in audio_paths:
            bundle.write(audio_path, f"audio/{profile}/{audio_path.name}")
    record = {"id": archive_id, "bookId": book_id, "profileId": profile, "status": "COMPLETED", "path": str(output)}
    _archives[archive_id] = record
    return record


def get_archive(archive_id: str) -> dict:
    record = _archives.get(archive_id)
    if not record:
        raise FileNotFoundError("Prepared-book archive was not found.")
    return record


def import_bookvoice(payload: bytes, filename: str) -> dict:
    with tempfile.TemporaryDirectory() as temp_dir:
        archive_path = Path(temp_dir) / "upload.bookvoice"
        archive_path.write_bytes(payload)
        return import_bookvoice_path(archive_path, filename)


def _zip_member_digest(bundle: zipfile.ZipFile, info: zipfile.ZipInfo) -> tuple[str, bytes]:
    digest = hashlib.sha256()
    prefix = b""
    with bundle.open(info, "r") as source:
        for chunk in iter(lambda: source.read(FILE_CHUNK_BYTES), b""):
            if len(prefix) < 4:
                prefix = (prefix + chunk)[:4]
            digest.update(chunk)
    return digest.hexdigest(), prefix


def _extract_zip_member(
    bundle: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    destination: Path,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with bundle.open(info, "r") as source, destination.open("wb") as output:
        shutil.copyfileobj(source, output, length=FILE_CHUNK_BYTES)


def _copy_file_atomic(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{destination.stem}-", suffix=".tmp", dir=destination.parent)
    os.close(fd)
    try:
        shutil.copy2(source, temp_name)
        os.replace(temp_name, destination)
    except Exception:
        Path(temp_name).unlink(missing_ok=True)
        raise


def import_bookvoice_path(path: Path, filename: str) -> dict:
    del filename
    try:
        bundle = zipfile.ZipFile(Path(path))
    except zipfile.BadZipFile as exc:
        raise ValueError("Prepared-book archive is invalid.") from exc
    with bundle, tempfile.TemporaryDirectory() as temp_dir:
        infos = _safe_archive_members(bundle)
        info_by_name = {
            info.filename.replace("\\", "/"): info
            for info in infos
            if not info.is_dir()
        }
        manifest_info = info_by_name.get("manifest.json")
        if not manifest_info:
            raise ValueError("Prepared-book archive has no manifest.")
        try:
            with bundle.open(manifest_info, "r") as source:
                manifest = json.loads(source.read(MAX_ARCHIVE_METADATA_BYTES + 1).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Prepared-book manifest is invalid.") from exc
        if not isinstance(manifest, dict) or manifest.get("schemaVersion") != SCHEMA_VERSION:
            raise ValueError("Unsupported prepared-book schema version.")
        profiles = manifest.get("profiles")
        if not isinstance(profiles, dict) or len(profiles) != 1:
            raise ValueError("Schema version 1 must contain exactly one narration profile.")
        if any(
            len(str(profile_id)) != 20
            or any(c not in "0123456789abcdef" for c in str(profile_id))
            for profile_id in profiles
        ):
            raise ValueError("Prepared-book archive contains an invalid narration profile.")
        book_id = str(manifest.get("id") or "")
        target = book_dir(book_id)
        source_info = info_by_name.get("document/source.pdf")
        if not source_info:
            raise ValueError("Prepared-book archive has no source PDF.")
        source_digest, source_prefix = _zip_member_digest(bundle, source_info)
        if source_prefix != b"%PDF":
            raise ValueError("Prepared-book source is not a PDF.")
        if source_digest != manifest.get("sourceSha256") or book_id != manifest.get("sourceSha256"):
            raise ValueError("Prepared-book PDF checksum does not match its manifest.")

        names = set(info_by_name)
        page_hashes = manifest.get("pageHashes")
        audio_checksums = manifest.get("audioChecksums")
        if not isinstance(page_hashes, dict) or not isinstance(audio_checksums, dict):
            raise ValueError("Prepared-book manifest is missing entry checksums.")
        audio_names = set()
        for name in names - {"manifest.json", "document/source.pdf"}:
            if name.startswith("pages/"):
                filename_part = PurePosixPath(name).name
                if len(PurePosixPath(name).parts) != 2 or not filename_part.removesuffix(".json").isdigit():
                    raise ValueError("Prepared-book archive contains an invalid page entry.")
                expected = page_hashes.get(filename_part)
            elif name.startswith("audio/"):
                audio_names.add(name)
                parts = PurePosixPath(name).parts
                if len(parts) != 3 or parts[1] not in profiles or not parts[2].startswith("page-") or not parts[2].endswith(".wav"):
                    raise ValueError("Prepared-book archive contains an invalid audio entry.")
                expected = audio_checksums.get(name)
            else:
                raise ValueError("Prepared-book archive contains an unsupported entry.")
            actual, _prefix = _zip_member_digest(bundle, info_by_name[name])
            if not expected or actual != expected:
                raise ValueError(f"Prepared-book checksum mismatch: {name}")

        expected_names = {
            *(f"pages/{name}" for name in page_hashes),
            *(str(name) for name in audio_checksums),
        }
        if not expected_names.issubset(names):
            raise ValueError("Prepared-book archive is missing a checksummed entry.")

        staging = Path(temp_dir) / "content"
        for name, info in info_by_name.items():
            if name == "manifest.json":
                continue
            destination = (
                staging / "source.pdf"
                if name == "document/source.pdf"
                else staging.joinpath(*PurePosixPath(name).parts)
            )
            _extract_zip_member(bundle, info, destination)
            if name in audio_names:
                _validate_wav_file(destination)

        existing_progress = None
        if (target / "manifest.json").exists():
            existing_progress = get_book(book_id).get("progress")
        target.mkdir(parents=True, exist_ok=True)
        _copy_file_atomic(staging / "source.pdf", target / "source.pdf")
        for source_path in staging.rglob("*"):
            if not source_path.is_file() or source_path == staging / "source.pdf":
                continue
            _copy_file_atomic(source_path, target / source_path.relative_to(staging))
        if existing_progress and int(existing_progress.get("updatedAt") or 0) > int((manifest.get("progress") or {}).get("updatedAt") or 0):
            manifest["progress"] = existing_progress
        _write_json(target / "manifest.json", manifest)
    return _summary(manifest)


def start_preparation(book_id: str, voice_id: str | None, language_id: str) -> dict:
    manifest = get_book(book_id)
    profile = profile_id(voice_id, language_id)
    previous_preparation = manifest.get("preparation") or {}
    for existing in _jobs.values():
        if (
            existing["bookId"] == book_id
            and existing["profileId"] == profile
            and existing["status"] in {"QUEUED", "RUNNING", "PAUSED"}
            and not existing["cancelRequested"]
        ):
            return {key: value for key, value in existing.items() if key != "cancelRequested"}
    page_count = int(manifest.get("pageCount") or 0)
    if page_count < 1:
        raise ValueError("No prepared page text is available for this book.")
    missing_pages = []
    prepared_pages = []
    for page in range(1, page_count + 1):
        try:
            page_meta = get_page(book_id, page)
            if not str(page_meta.get("text") or "").strip():
                missing_pages.append(page)
            elif is_page_prepared(book_id, profile, page, page_meta):
                prepared_pages.append(page)
        except (ValueError, FileNotFoundError):
            missing_pages.append(page)
    if missing_pages:
        preview = ", ".join(str(page) for page in missing_pages[:20])
        suffix = "…" if len(missing_pages) > 20 else ""
        raise ValueError(f"Extract page text before preparation; missing pages {preview}{suffix}.")
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "bookId": book_id,
        "profileId": profile,
        "voiceId": voice_id,
        "languageId": validate_language_id(language_id),
        "status": "COMPLETED" if len(prepared_pages) == page_count else "QUEUED",
        "completedPages": prepared_pages if len(prepared_pages) == page_count else [],
        "totalPages": page_count,
        "currentPage": None,
        "error": None,
        "cancelRequested": False,
    }
    if (
        previous_preparation.get("profileId") == profile
        and previous_preparation.get("legacyWavRecoveryAttempted")
    ):
        job["legacyWavRecoveryAttempted"] = True
    _jobs[job_id] = job
    manifest["preparation"] = {key: value for key, value in job.items() if key != "cancelRequested"}
    _write_json(_manifest_path(book_id), manifest)
    if job["status"] != "COMPLETED":
        threading.Thread(target=_run_preparation, args=(job_id, voice_id, language_id), daemon=True).start()
    return {key: value for key, value in job.items() if key != "cancelRequested"}


def _run_preparation(job_id: str, voice_id: str | None, language_id: str) -> None:
    from services.tts_service import GenerationCancelled, TtsPriority, narrate_text, submit_tts

    job = _jobs[job_id]
    job["status"] = "RUNNING"
    try:
        for page in range(1, job["totalPages"] + 1):
            if job["cancelRequested"]:
                job["status"] = "CANCELLED"
                break
            page_meta = get_page(job["bookId"], page)
            if is_page_prepared(job["bookId"], job["profileId"], page, page_meta):
                job["completedPages"].append(page)
                continue
            job["currentPage"] = page
            session = f"book-{job['bookId'][:12]}"
            while True:
                if job["cancelRequested"]:
                    job["status"] = "CANCELLED"
                    break
                future = submit_tts(TtsPriority.PREPARE, narrate_text, page_meta["text"], session, page, voice_id, language_id)
                job["_future"] = future
                try:
                    result = future.result()
                    break
                except (GenerationCancelled, CancelledError):
                    if job["cancelRequested"]:
                        job["status"] = "CANCELLED"
                        break
                    job["status"] = "PAUSED"
                    _persist_job(job)
                    time.sleep(0.25)
                    job["status"] = "RUNNING"
                finally:
                    job.pop("_future", None)
            if job["status"] == "CANCELLED":
                break
            if job["cancelRequested"]:
                job["status"] = "CANCELLED"
                break
            relative = str(result["audio_url"]).removeprefix("/sessions/")
            source = Path(os.environ.get("DATA_DIR", "data")) / "sessions" / relative
            mark_page_audio(
                job["bookId"], job["profileId"], page, source,
                result.get("word_timings") or [], result.get("duration_s") or 0,
                voice_id, language_id,
            )
            job["completedPages"].append(page)
            _persist_job(job)
        if job["status"] == "RUNNING":
            job["status"] = "COMPLETED"
    except Exception as exc:  # noqa: BLE001 - persisted for the UI
        job["status"] = "FAILED"
        job["error"] = str(exc)
    finally:
        job["currentPage"] = None
        _persist_job(job)


def _persist_job(job: dict) -> None:
    manifest = get_book(job["bookId"])
    manifest["preparation"] = {
        key: value
        for key, value in job.items()
        if key != "cancelRequested" and not key.startswith("_")
    }
    manifest["updatedAt"] = int(time.time())
    _write_json(_manifest_path(job["bookId"]), manifest)


def get_preparation(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if not job:
        raise FileNotFoundError("Preparation job was not found.")
    return {
        key: value
        for key, value in job.items()
        if key != "cancelRequested" and not key.startswith("_")
    }


def cancel_preparation(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if not job:
        return {"id": job_id, "status": "CANCELLED"}
    if job["status"] in {"COMPLETED", "FAILED", "CANCELLED"}:
        return get_preparation(job_id)
    job["cancelRequested"] = True
    future = job.get("_future")
    if future is not None:
        future.cancel()
    if job["status"] == "RUNNING":
        from services.tts_service import bump_generation

        bump_generation()
    job["status"] = "CANCELLED"
    _persist_job(job)
    return get_preparation(job_id)
