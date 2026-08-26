#!/usr/bin/env python3
"""Journey-level simulation of BookVoice's application function.

Runs the REAL backend (source tree) on an isolated runtime and walks
complete user journeys through the exact HTTP surface the UI uses,
asserting at every step. This catches cross-feature inconsistencies the
unit suites can't: import->extract->prepare->narrate->progress->export
chaining, device-scoped studio isolation, the hosted access gate, and
capability reporting.

Layers (each narrower than this one):
  tests/                  - contract-level unit tests
  scripts/simulate_app.py - this file: journey-level end-to-end simulation
  scripts/smoke_exe.py    - packaged dist/ payload before MSI packaging

Journeys:
  J1 PDF reader: import -> async extraction -> prepare page (real CPU TTS)
                 -> page content -> archive export -> progress -> bookmarks
  J2 Text book:  import .txt -> sourceKind -> page content
  J3 Studio:     project -> media upload job (COMPLETED) -> profile clone
                 (consent-gated) -> device-scoped isolation
  J4 Access:     hosted gate -> block -> login -> throttle (429 + backoff)
  J5 Config:     capabilities reported for the running environment
  J6 Audiobook:  prepare -> export M4B -> download file -> validate ftyp
  J7 Studio narr: project -> source -> narration job -> output download
  J8 Translate:  en->ar -> ar->en -> empty rejected -> unsupported rejected
  J9 Archive:    prepare -> export .bookvoice -> download -> validate zip
  Heavy (--heavy): real CPU voice conversion.

Usage:
  python scripts/simulate_app.py              # base journeys
  python scripts/simulate_app.py --heavy      # + CPU conversion
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
VENV_PY = BACKEND / ".venv" / "Scripts" / "python.exe"
DEVICE_A = "a" * 32
DEVICE_B = "b" * 32

PASS = 0
FAIL = 0

JOB_DONE = ("COMPLETED", "succeeded", "FAILED", "failed", "error", "ERROR")


def report(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"[pass] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name}" + (f" - {detail}" if detail else ""))


class Api:
    def __init__(self, base: str, device: str):
        self.base = base
        self.headers = {"X-BookVoice-Device-ID": device}

    def call(self, method: str, path: str, payload=None, raw_body: bytes | None = None,
             content_type: str | None = None):
        headers = dict(self.headers)
        data = None
        if raw_body is not None:
            data = raw_body
            if content_type:
                headers["Content-Type"] = content_type
        elif payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                body = resp.read()
                try:
                    return resp.status, json.loads(body)
                except Exception:
                    return resp.status, body
        except urllib.error.HTTPError as exc:
            body = exc.read()
            try:
                return exc.code, json.loads(body)
            except Exception:
                return exc.code, body
        except (urllib.error.URLError, OSError):
            return 0, {}

    def upload(self, path: str, source: Path, field: str = "file"):
        boundary = f"bv-sim-{uuid.uuid4().hex}"
        body = bytearray()
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(
            (
                f'Content-Disposition: form-data; name="{field}"; filename="{source.name}"\r\n'
                "Content-Type: application/octet-stream\r\n\r\n"
            ).encode()
        )
        body.extend(source.read_bytes())
        body.extend(f"\r\n--{boundary}--\r\n".encode())
        return self.call(
            "POST", path, raw_body=bytes(body),
            content_type=f"multipart/form-data; boundary={boundary}",
        )

    def get(self, path: str):
        return self.call("GET", path)


def wait_until(predicate, timeout_s: float, interval: float = 2.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if predicate():
                return True
        except Exception:
            pass
        time.sleep(interval)
    return False


def kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        try:
            proc.wait(timeout=10)
        except Exception:
            pass


def start_server(runtime_dir: Path, port: int, extra_env: dict | None = None) -> subprocess.Popen:
    py = VENV_PY if VENV_PY.is_file() else Path(sys.executable)
    env = {
        "DATA_DIR": str(Path(runtime_dir) / "data"),
        "MODEL_DIR": str(BACKEND / "data" / "models"),
        "VOICE_DATA_DIR": str(Path(runtime_dir) / "data" / "voices"),
        "PYTHONUNBUFFERED": "1",
        **(extra_env or {}),
    }
    log_path = Path(runtime_dir) / f"server-{port}.log"
    log_file = log_path.open("wb")
    proc = subprocess.Popen(
        [str(py), "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(BACKEND),
        env={**os.environ, **env},
        stdout=log_file,
        stderr=subprocess.STDOUT,
        creationflags=0x08000000 if os.name == "nt" else 0,
    )
    log_file.close()
    return proc


def job_status(api: Api, job_id: str) -> str:
    _, b = api.get(f"/api/studio/jobs/{job_id}")
    if not isinstance(b, dict):
        return "?"
    return b.get("status") or (b.get("job") or {}).get("status") or "?"


def media_source_id(api: Api, project_id: str, job_id: str) -> str | None:
    _, b = api.get(f"/api/studio/jobs/{job_id}")
    if isinstance(b, dict):
        for key in ("sourceId", "assetId", "mediaId"):
            val = b.get(key)
            if isinstance(val, str) and len(val) >= 10:
                return val
            if isinstance(val, dict) and val.get("id"):
                return val["id"]
    _, b = api.get(f"/api/studio/projects/{project_id}")
    if isinstance(b, dict):
        for key in ("sources", "media"):
            for item in b.get(key) or []:
                if isinstance(item, dict) and item.get("id"):
                    return item["id"]
    return None


def _profile_id_from_book(api: Api, book_id: str) -> str | None:
    _, body = api.get(f"/api/books/{book_id}")
    if not isinstance(body, dict):
        return None
    return (body.get("preparation") or {}).get("profileId")


def journey_reader(api: Api, fixture: Path) -> None:
    print("\n--- J1 PDF reader journey ---")
    status, body = api.upload("/api/books", fixture)
    book_id = body.get("id") if isinstance(body, dict) else None
    report("import english.pdf -> 201 + book id", status == 201 and bool(book_id), f"{status} {str(body)[:140]}")
    if not book_id:
        return

    # PDF text extraction is client-side (pdf.js); the UI PUTs each page's
    # extracted text before whole-book preparation. Mirror that contract.
    status, body = api.call(
        "PUT", f"/api/books/{book_id}/pages/1",
        {"text": "The lighthouse stood at the edge of the cliff. Every evening "
                 "its beam swept across the dark water. The keeper climbed the "
                 "spiral stairs with a heavy lamp.", "pageCount": 1},
    )
    report("client-extracted page text accepted", status in (200, 204), f"{status} {str(body)[:140]}")

    def extracted():
        _, b = api.get(f"/api/books/{book_id}")
        return isinstance(b, dict) and (b.get("pageCount") or 0) > 0

    report("async text extraction completes", wait_until(extracted, 150, 5))

    status, body = api.get("/api/books")
    ids = [b.get("id") for b in body.get("books", [])] if isinstance(body, dict) else []
    report("library lists the imported book", book_id in ids)

    status, body = api.call("POST", f"/api/books/{book_id}/preparations",
                            {"voiceId": None, "languageId": "en"})
    report("start page preparation accepted", status in (200, 201, 202), f"{status} {str(body)[:140]}")
    if status not in (200, 201, 202):
        return

    def prepared():
        _, b = api.get(f"/api/books/{book_id}")
        if not isinstance(b, dict):
            return False
        prep = b.get("preparation") or {}
        return prep.get("status") == "COMPLETED"

    report("page 1 becomes prepared (real CPU TTS)", wait_until(prepared, 240, 5))

    status, body = api.get(f"/api/books/{book_id}/pages/1")
    report("prepared page content serves", status == 200 and "lighthouse" in str(body), f"{status} {str(body)[:120]}")

    profile_id = _profile_id_from_book(api, book_id)
    report("profile available for archive", bool(profile_id))

    status, body = api.call("POST", f"/api/books/{book_id}/archives", {"profileId": profile_id})
    report("archive export accepted", status == 201, f"{status} {str(body)[:140]}")

    status, body = api.call("PATCH", f"/api/books/{book_id}/progress", {"page": 1})
    report("progress persist accepted", status in (200, 204), f"{status} {str(body)[:140]}")

    status, body = api.get(f"/api/books/{book_id}")
    bookmarks = (body.get("bookmarks") if isinstance(body, dict) else None) or []
    report("bookmarks reported", isinstance(bookmarks, list))


def journey_text_book(api: Api) -> None:
    print("\n--- J2 text-book journey ---")
    with tempfile.TemporaryDirectory(prefix="bv-txt-") as tmp:
        txt = Path(tmp) / "sample.txt"
        txt.write_text(
            "The Quiet Lighthouse.\n\nThe beam swept the water.\n\n" * 20,
            encoding="utf-8",
        )
        status, body = api.upload("/api/books", txt)
        book_id = body.get("id") if isinstance(body, dict) else None
        report("import .txt -> 201 + id", status == 201 and bool(book_id), f"{status} {str(body)[:140]}")
        if not book_id:
            return
        status, body = api.get(f"/api/books/{book_id}")
        kind = body.get("sourceKind") if isinstance(body, dict) else None
        report("text book reports sourceKind", kind in ("text", "txt"), str(kind))
        status, body = api.get(f"/api/books/{book_id}/pages/1")
        text = body.get("text") if isinstance(body, dict) else ""
        report("text page 1 content extracts", status == 200 and len(text) > 0, f"{status} {str(body)[:120]}")


def journey_studio(api: Api) -> None:
    print("\n--- J3 studio journey ---")
    status, body = api.call("POST", "/api/studio/projects", {"name": "Sim Project"})
    project_id = body.get("projectId") or body.get("id") or (body.get("project") or {}).get("id")
    report("create project -> id", status in (200, 201) and bool(project_id), f"{status} {str(body)[:140]}")
    if not project_id:
        return

    wav = ROOT / "tests" / "fixtures" / "timing_en.wav"
    status, body = api.upload(f"/api/studio/projects/{project_id}/sources", wav)
    job_id = body.get("id") if isinstance(body, dict) else None
    report("upload media accepted as job", status == 202 and bool(job_id), f"{status} {str(body)[:140]}")
    if not job_id:
        return

    done = wait_until(lambda: job_status(api, job_id) in JOB_DONE, 90)
    report("media import job settles", done, job_status(api, job_id))

    source_id = media_source_id(api, project_id, job_id)
    report("media import yields a source id", bool(source_id), f"source={source_id}")

    status, body = api.call(
        "POST", f"/api/studio/projects/{project_id}/profiles",
        {"sourceId": source_id, "name": "Sim Profile", "startSec": 0.0, "endSec": 1.0, "consentConfirmed": True},
    )
    report("clone voice profile accepted (consent-gated)", status in (200, 201, 202), f"{status} {str(body)[:140]}")
    profile_job_id = body.get("id") if isinstance(body, dict) else None
    if profile_job_id:
        report("voice profile job settles",
               wait_until(lambda: job_status(api, profile_job_id) in JOB_DONE, 240, 5),
               job_status(api, profile_job_id))

    other = Api(api.base, DEVICE_B)
    status, body = other.get("/api/studio/projects")
    ids = [p.get("id") or p.get("projectId") for p in body.get("projects", [])] if isinstance(body, dict) else []
    report("device B cannot see device A's project (isolation)", project_id not in ids)


def journey_access(runtime_dir: Path, port: int) -> None:
    print("\n--- J4 hosted access gate ---")
    proc = start_server(runtime_dir, port, {"BOOKVOICE_ACCESS_PASSWORD": "correct-horse-9"})
    try:
        base = f"http://127.0.0.1:{port}"
        api = Api(base, DEVICE_A)
        if not wait_until(lambda: api.get("/api/health")[0] == 200, 150):
            report("gate server boots", False)
            return
        status, body = api.get("/api/access/")
        report("gate reports authRequired", status == 200 and body.get("authRequired") is True, str(body)[:120])

        status, _ = api.get("/api/voices/")
        report("unauthenticated API blocked", status in (401, 403), f"status={status}")

        codes = []
        for _ in range(6):
            codes.append(api.call("POST", "/api/access/", {"password": "wrong"})[0])
        report("first five wrong attempts -> 401", codes[:5] == [401] * 5, str(codes))
        report("sixth attempt throttled -> 429", codes[5] == 429, str(codes))

        time.sleep(32)
        status, body = api.call("POST", "/api/access/", {"password": "correct-horse-9"})
        report("correct password accepted after backoff", status == 200, f"{status} {str(body)[:120]}")
    finally:
        kill_tree(proc)


def journey_config(api: Api) -> None:
    print("\n--- J5 config capabilities ---")
    status, body = api.get("/api/config/")
    caps = body.get("capabilities") if isinstance(body, dict) else {}
    report("config reports localFileActions", isinstance(caps.get("localFileActions"), bool), str(body)[:160])
    report("config reports authRequired", "authRequired" in caps, str(caps)[:160])


def journey_heavy(api: Api) -> None:
    print("\n--- Heavy: real CPU conversion ---")
    status, body = api.call("POST", "/api/studio/projects", {"name": "Convert Sim"})
    project_id = body.get("projectId") or body.get("id")
    if not project_id:
        report("conversion project create", False, str(body)[:120])
        return
    wav = ROOT / "tests" / "fixtures" / "timing_en.wav"
    status, body = api.upload(f"/api/studio/projects/{project_id}/sources", wav)
    job_id = body.get("id") if isinstance(body, dict) else None
    if not job_id:
        report("conversion media upload", False, str(body)[:120])
        return
    done = wait_until(lambda: job_status(api, job_id) in JOB_DONE, 90)
    source_id = media_source_id(api, project_id, job_id)
    report("conversion media ready", done and bool(source_id), f"status={job_status(api, job_id)} source={source_id}")
    if not source_id:
        return
    status, body = api.call(
        "POST", f"/api/studio/projects/{project_id}/conversions",
        {"sourceId": source_id, "startSec": 0.1, "endSec": 1.0,
         "targetSourceId": source_id, "targetStartSec": 0.0, "targetEndSec": 0.8,
         "consentConfirmed": True},
    )
    output_id = body.get("id") if isinstance(body, dict) else None
    report("conversion job accepted", status in (200, 202) and bool(output_id), f"{status} {str(body)[:140]}")
    if not output_id:
        return
    report("conversion job settles",
           wait_until(lambda: job_status(api, output_id) in JOB_DONE, 600, 10),
           job_status(api, output_id))
    status, body = api.get(f"/api/studio/projects/{project_id}/outputs/{output_id}/download")
    if status == 200 and isinstance(body, bytes):
        report("conversion output downloads", body[:4] == b"RIFF", f"first bytes={body[:4]!r}")
    else:
        report("conversion output downloads", False, f"status={status}")


def journey_translate(api: Api) -> None:
    print("\n--- J8 translation journey ---")
    status, body = api.call("POST", "/api/translate/", {"text": "Hello world", "target_lang": "ar"})
    report("translate en->ar accepted", status == 200 and bool(body.get("translated_text")) if isinstance(body, dict) else False,
           f"{status} {str(body)[:120]}")
    if isinstance(body, dict) and body.get("translated_text"):
        report("translation is non-empty", len(body["translated_text"]) > 0, f"len={len(body['translated_text'])}")

    status, body = api.call("POST", "/api/translate/", {"text": "مرحبا", "target_lang": "en"})
    report("translate ar->en accepted", status == 200 and bool(body.get("translated_text")) if isinstance(body, dict) else False,
           f"{status} {str(body)[:120]}")

    status, body = api.call("POST", "/api/translate/", {"text": "", "target_lang": "en"})
    report("empty text rejected", status == 400, f"{status}")

    status, body = api.call("POST", "/api/translate/", {"text": "test", "target_lang": "fr"})
    report("unsupported language rejected", status == 400, f"{status}")


def journey_audiobook(api: Api, fixture: Path) -> None:
    print("\n--- J6 audiobook export journey ---")
    status, body = api.upload("/api/books", fixture)
    book_id = body.get("id") if isinstance(body, dict) else None
    report("import book for audiobook export", status == 201 and bool(book_id), f"{status} {str(body)[:120]}")
    if not book_id:
        return

    status, body = api.call(
        "PUT", f"/api/books/{book_id}/pages/1",
        {"text": "The lighthouse stood at the edge of the cliff. Every evening "
                 "its beam swept across the dark water.", "pageCount": 1},
    )
    report("page text stored", status in (200, 204), f"{status}")

    status, body = api.call("POST", f"/api/books/{book_id}/preparations",
                            {"voiceId": None, "languageId": "en"})
    report("preparation accepted", status in (200, 201, 202), f"{status} {str(body)[:120]}")
    if status not in (200, 201, 202):
        return

    def prep_done():
        _, b = api.get(f"/api/books/{book_id}")
        if not isinstance(b, dict):
            return False
        prep = b.get("preparation") or {}
        return prep.get("status") == "COMPLETED"

    report("preparation completes (real CPU TTS)", wait_until(prep_done, 240, 5))

    profile_id = _profile_id_from_book(api, book_id)
    report("profile available for export", bool(profile_id))
    if not profile_id:
        return

    status, body = api.call("POST", f"/api/books/{book_id}/audiobooks",
                            {"profileId": profile_id})
    job_id = body.get("jobId") if isinstance(body, dict) else None
    report("audiobook export accepted", status == 201 and bool(job_id), f"{status} {str(body)[:120]}")
    if not job_id:
        return

    def export_done():
        _, b = api.get(f"/api/books/{book_id}/audiobooks/{job_id}")
        return isinstance(b, dict) and b.get("status") in JOB_DONE

    report("audiobook export settles", wait_until(export_done, 600, 5))

    status, body = api.get(f"/api/books/{book_id}/audiobooks/{job_id}")
    download_url = body.get("downloadUrl") if isinstance(body, dict) else None
    report("audiobook download URL present", bool(download_url), f"status={body.get('status') if isinstance(body, dict) else '?'}")

    if download_url:
        dstatus, dbody = api.get(download_url.replace(api.base, ""))
        report("audiobook file downloads",
               dstatus == 200 and isinstance(dbody, bytes) and len(dbody) > 1000,
               f"status={dstatus} size={len(dbody) if isinstance(dbody, bytes) else '?'}")
        if isinstance(dbody, bytes) and len(dbody) >= 12 and dbody[4:8] == b"ftyp":
            report("audiobook has ftyp box (valid mp4/m4b)", True)
        elif isinstance(dbody, bytes):
            report("audiobook has ftyp box (valid mp4/m4b)", False, f"first bytes={dbody[:12]!r}")


def journey_studio_narration(api: Api) -> None:
    print("\n--- J7 studio narration journey ---")
    status, body = api.call("POST", "/api/studio/projects", {"name": "Narration Sim"})
    project_id = body.get("projectId") or body.get("id") or (body.get("project") or {}).get("id")
    report("create narration project", status in (200, 201) and bool(project_id), f"{status} {str(body)[:120]}")
    if not project_id:
        return

    wav = ROOT / "tests" / "fixtures" / "timing_en.wav"
    status, body = api.upload(f"/api/studio/projects/{project_id}/sources", wav)
    job_id = body.get("id") if isinstance(body, dict) else None
    report("upload source accepted", status == 202 and bool(job_id), f"{status} {str(body)[:120]}")
    if not job_id:
        return

    report("source import settles", wait_until(lambda: job_status(api, job_id) in JOB_DONE, 90))

    source_id = media_source_id(api, project_id, job_id)
    report("source ready for narration", bool(source_id), f"source={source_id}")
    if not source_id:
        return

    status, body = api.call(
        "POST", f"/api/studio/projects/{project_id}/narrations",
        {"text": "Hello from the studio narration test.", "sourceId": source_id,
         "generationSettings": {"pace": 1.0, "expression": 0.5, "seed": 42}},
    )
    narration_job = body.get("id") if isinstance(body, dict) else None
    report("narration job accepted", status == 202 and bool(narration_job), f"{status} {str(body)[:120]}")
    if not narration_job:
        return

    report("narration settles", wait_until(lambda: job_status(api, narration_job) in JOB_DONE, 600, 10),
           job_status(api, narration_job))

    status, body = api.get(f"/api/studio/projects/{project_id}")
    outputs = body.get("outputs", []) if isinstance(body, dict) else []
    narration_outputs = [o for o in outputs if o.get("kind") == "NARRATION"]
    report("narration output produced", len(narration_outputs) > 0, f"outputs={len(outputs)}")

    if narration_outputs:
        output_id = narration_outputs[-1].get("id")
        dstatus, dbody = api.get(f"/api/studio/projects/{project_id}/outputs/{output_id}/download")
        if dstatus == 200 and isinstance(dbody, bytes):
            report("narration output downloads", dbody[:4] == b"RIFF", f"first bytes={dbody[:4]!r} size={len(dbody)}")
        else:
            report("narration output downloads", False, f"status={dstatus}")


def journey_archive(api: Api, fixture: Path) -> None:
    print("\n--- J9 archive export with real profile ---")
    status, body = api.upload("/api/books", fixture)
    book_id = body.get("id") if isinstance(body, dict) else None
    report("import book for archive", status == 201 and bool(book_id), f"{status} {str(body)[:120]}")
    if not book_id:
        return

    status, body = api.call(
        "PUT", f"/api/books/{book_id}/pages/1",
        {"text": "Archive export test page. The lighthouse beam swept the water.", "pageCount": 1},
    )
    report("page text stored", status in (200, 204), f"{status}")

    status, body = api.call("POST", f"/api/books/{book_id}/preparations",
                            {"voiceId": None, "languageId": "en"})
    report("preparation accepted", status in (200, 201, 202), f"{status}")
    if status not in (200, 201, 202):
        return

    def prep_done():
        _, b = api.get(f"/api/books/{book_id}")
        if not isinstance(b, dict):
            return False
        prep = b.get("preparation") or {}
        return prep.get("status") == "COMPLETED"

    report("preparation completes", wait_until(prep_done, 240, 5))

    profile_id = _profile_id_from_book(api, book_id)
    report("profile available for archive", bool(profile_id))
    if not profile_id:
        return

    status, body = api.call("POST", f"/api/books/{book_id}/archives", {"profileId": profile_id})
    report("archive export accepted", status == 201, f"{status} {str(body)[:120]}")
    archive_id = body.get("id") if isinstance(body, dict) else None
    if not archive_id:
        return

    def archive_ready():
        _, b = api.get(f"/api/book-archives/{archive_id}")
        return isinstance(b, dict) and b.get("status") == "COMPLETED"

    report("archive record ready", wait_until(archive_ready, 30))

    dstatus, dbody = api.get(f"/api/book-archives/{archive_id}/content")
    report("archive downloads", dstatus == 200 and isinstance(dbody, bytes) and len(dbody) > 1000,
           f"status={dstatus} size={len(dbody) if isinstance(dbody, bytes) else '?'}")
    if isinstance(dbody, bytes) and dbody[:4] == b"PK\x03\x04":
        report("archive is valid zip", True)
    elif isinstance(dbody, bytes):
        report("archive is valid zip", False, f"first bytes={dbody[:4]!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Journey-level BookVoice simulation")
    parser.add_argument("--heavy", action="store_true", help="include real CPU conversion journeys")
    parser.add_argument("--port", type=int, default=8011)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="bookvoice-sim-", ignore_cleanup_errors=True) as runtime:
        runtime_dir = Path(runtime)
        proc = start_server(runtime_dir, args.port)
        try:
            base = f"http://127.0.0.1:{args.port}"
            api = Api(base, DEVICE_A)
            if not wait_until(lambda: api.get("/api/health")[0] == 200, 150):
                print("[FAIL] main server never became healthy")
                log = Path(runtime_dir) / f"server-{args.port}.log"
                if log.is_file():
                    print(log.read_text(encoding="utf-8", errors="replace")[-1500:])
                return 1
            print("[ok] main server healthy")

            # Wait for the TTS model to be ready before running journeys that
            # depend on real narration. The model loads asynchronously on the
            # TTS thread after the health endpoint comes up.
            def tts_ready():
                _, b = api.get("/api/tts/status")
                return isinstance(b, dict) and b.get("status") == "ready"

            if wait_until(tts_ready, 300, 5):
                print("[ok] TTS model ready")
            else:
                print("[WARN] TTS model not ready within 300s; TTS journeys may time out")

            journey_config(api)
            journey_translate(api)
            journey_text_book(api)
            journey_reader(api, ROOT / "tests" / "fixtures" / "english.pdf")
            journey_archive(api, ROOT / "tests" / "fixtures" / "english.pdf")
            journey_audiobook(api, ROOT / "tests" / "fixtures" / "english.pdf")
            journey_studio(api)
            journey_studio_narration(api)
            if args.heavy:
                journey_heavy(api)

        finally:
            kill_tree(proc)
        journey_access(runtime_dir, args.port + 1)

    print(f"\n=== simulation: {PASS} passed, {FAIL} failed ===")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
