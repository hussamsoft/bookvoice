#!/usr/bin/env python3
"""End-to-end packaged Voice Studio smoke using only local resources."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import launch  # noqa: E402


SETTINGS = {
    "pace": 1.0,
    "expression": 0.5,
    "temperature": 0.8,
    "guidance": None,
    "seed": 917,
}


def request(base: str, method: str, path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"} if data is not None else {}
    call = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(call, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed ({exc.code}): {detail}") from exc


def upload(base: str, path: str, source: Path) -> dict:
    boundary = f"bookvoice-{uuid.uuid4().hex}"
    body = bytearray()
    body.extend(f"--{boundary}\r\n".encode())
    body.extend(
        (
            f'Content-Disposition: form-data; name="file"; filename="{source.name}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
    )
    body.extend(source.read_bytes())
    body.extend(f"\r\n--{boundary}--\r\n".encode())
    call = urllib.request.Request(
        base + path,
        data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(call, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"upload {path} failed ({exc.code}): {detail}") from exc


def wait_job(base: str, job: dict, timeout_s: int = 600) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        current = request(base, "GET", f"/api/studio/jobs/{job['id']}")
        if current["status"] == "COMPLETED":
            return current
        if current["status"] in {"FAILED", "CANCELLED", "INTERRUPTED"}:
            raise RuntimeError(current.get("error", {}).get("message") or current.get("message"))
        time.sleep(0.5)
    raise TimeoutError(f"Studio job {job['id']} did not finish in {timeout_s} seconds.")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assert_narration_silence(path: Path) -> None:
    """Prove the packaged WAV retains the head/tail cutoff protection."""
    fmt = None
    data = None
    with path.open("rb") as source:
        if source.read(4) != b"RIFF":
            raise RuntimeError("Packaged Studio narration is not a RIFF WAV.")
        source.read(4)
        if source.read(4) != b"WAVE":
            raise RuntimeError("Packaged Studio narration is not a WAVE file.")
        while True:
            header = source.read(8)
            if len(header) < 8:
                break
            chunk_id, chunk_size = struct.unpack("<4sI", header)
            payload = source.read(chunk_size)
            if chunk_size & 1:
                source.read(1)
            if chunk_id == b"fmt ":
                fmt = payload
            elif chunk_id == b"data":
                data = payload
    if fmt is None or data is None or len(fmt) < 16:
        raise RuntimeError("Packaged Studio narration has incomplete WAV chunks.")

    audio_format, channels, rate, _, block_align, bits = struct.unpack_from("<HHIIHH", fmt)
    if audio_format == 0xFFFE and len(fmt) >= 26:
        audio_format = struct.unpack_from("<H", fmt, 24)[0]
    frames = len(data) // block_align

    def window(frame_count: int, *, from_end: bool = False) -> bytes:
        byte_count = min(frames, frame_count) * block_align
        return data[-byte_count:] if from_end else data[:byte_count]

    def peak(raw: bytes) -> float:
        if audio_format == 3 and bits == 32:
            return max((abs(value[0]) for value in struct.iter_unpack("<f", raw)), default=0.0)
        if audio_format == 1 and bits == 16:
            return max((abs(value[0]) / 32768.0 for value in struct.iter_unpack("<h", raw)), default=0.0)
        raise RuntimeError(
            f"Packaged Studio narration uses unsupported WAV encoding {audio_format}/{bits}."
        )

    leading = window(int(rate * 0.25))
    trailing = window(int(rate * 0.35), from_end=True)
    if peak(leading) > 1e-6 or peak(trailing) > 1e-6:
        raise RuntimeError("Packaged Studio narration is missing silent cutoff buffers.")


def wait_health(base: str, timeout_s: int = 90) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            request(base, "GET", "/api/health")
            return
        except (OSError, RuntimeError):
            time.sleep(1)
    raise TimeoutError("Packaged server did not become healthy.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run packaged Voice Studio end-to-end smoke")
    parser.add_argument("--app-dir", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    app_dir = args.app_dir.resolve()
    package_error = launch.validate_package(str(app_dir))
    if package_error:
        raise SystemExit(package_error)

    ffmpeg = app_dir / "tools" / "ffmpeg" / "ffmpeg.exe"
    ffprobe = app_dir / "tools" / "ffmpeg" / "ffprobe.exe"
    if not ffmpeg.is_file() or not ffprobe.is_file():
        raise SystemExit("Packaged FFmpeg tools are missing.")

    with tempfile.TemporaryDirectory(prefix="bookvoice-studio-e2e-") as temp_dir:
        runtime = Path(temp_dir)
        source_wav = runtime / "voice-source.wav"
        source_mp4 = runtime / "video-source.mp4"
        female_reference = app_dir / "data" / "default_voices" / "open_female.wav"
        male_reference = app_dir / "data" / "default_voices" / "open_male.wav"
        if not female_reference.is_file() or not male_reference.is_file():
            raise SystemExit("Packaged speech references are missing.")
        shutil.copy2(female_reference, source_wav)
        subprocess.run(
            [str(ffmpeg), "-y", "-loglevel", "error", "-f", "lavfi", "-i",
             "color=c=0x496b86:s=320x180:d=8:r=24", "-i", str(male_reference), "-t", "8", "-shortest",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source_mp4)],
            check=True,
        )
        original_hashes = {source_wav.name: sha256(source_wav), source_mp4.name: sha256(source_mp4)}

        log = launch.Logger(str(runtime / "smoke.log"))
        worker = launch.packaged_worker(str(app_dir), log)
        if not worker:
            raise SystemExit("Packaged worker runtime is missing.")
        env = launch.build_env(str(app_dir), str(runtime / "runtime"))
        port = launch.pick_port(log)
        base = f"http://127.0.0.1:{port}"
        server_log_path = runtime / "server.log"
        with server_log_path.open("wb") as server_log:
            process = subprocess.Popen(
                [worker, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port)],
                cwd=app_dir,
                env=env,
                stdout=server_log,
                stderr=subprocess.STDOUT,
                creationflags=launch._no_window(),
            )
            try:
                wait_health(base)
                project = request(base, "POST", "/api/studio/projects", {"name": "Packaged Studio smoke"})
                project_path = f"/api/studio/projects/{project['id']}"

                wait_job(base, upload(base, project_path + "/sources", source_wav))
                wait_job(base, upload(base, project_path + "/sources", source_mp4))
                reopened = request(base, "GET", project_path)
                audio_source = next(item for item in reopened["sources"] if item["mediaType"] == "AUDIO")
                video_source = next(item for item in reopened["sources"] if item["mediaType"] == "VIDEO")
                if not video_source.get("previewUrl"):
                    raise RuntimeError("Packaged video import did not publish a browser preview URL.")
                preview_path = runtime / "video-preview.mp4"
                urllib.request.urlretrieve(base + video_source["previewUrl"], preview_path)
                preview_probe = subprocess.run(
                    [
                        str(ffprobe), "-v", "error", "-show_entries",
                        "stream=codec_type,codec_name,width,height:format=duration",
                        "-of", "json", str(preview_path),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                preview_streams = json.loads(preview_probe.stdout).get("streams") or []
                preview_codecs = {
                    (stream.get("codec_type"), stream.get("codec_name"))
                    for stream in preview_streams
                }
                if ("video", "h264") not in preview_codecs or ("audio", "aac") not in preview_codecs:
                    raise RuntimeError(
                        f"Packaged browser preview codecs are incompatible: {sorted(preview_codecs)}"
                    )

                profile_ids = []
                for source, name in ((audio_source, "Smoke audio voice"), (video_source, "Smoke video voice")):
                    profile_job = wait_job(base, request(base, "POST", project_path + "/profiles", {
                        "sourceId": source["id"], "name": name, "startSec": 1, "endSec": 7,
                        "consentConfirmed": True,
                    }))
                    profile_ids.append(profile_job["result"]["voiceId"])

                narration_text = "BookVoice Studio packaged smoke test."
                narration_results = []
                for voice_id in profile_ids:
                    narration_results.append(wait_job(base, request(base, "POST", project_path + "/narrations", {
                        "text": narration_text, "languageId": "en", "voiceId": voice_id,
                        "generationSettings": SETTINGS,
                    })))
                reopened = request(base, "GET", project_path)
                narration_outputs = [
                    next(item for item in reopened["outputs"] if item["id"] == result["result"]["outputId"])
                    for result in narration_results
                ]
                if [item.get("voiceId") for item in narration_outputs] != profile_ids:
                    raise RuntimeError("Packaged narration did not retain its imported voice profiles.")
                # Standalone narrations include a 0.3 s head and 0.4 s tail safety bed.
                # Repair synthesis intentionally does not, so size each repair range from
                # its matching voice's speech duration instead of reusing another voice.
                repair_durations = [
                    min(
                        float(source["durationSec"]),
                        max(0.25, float(output["durationSec"]) - 0.7),
                    )
                    for source, output in zip(
                        (audio_source, video_source), narration_outputs, strict=True
                    )
                ]

                audio_repair = wait_job(base, request(base, "POST", project_path + "/repairs", {
                    "assetId": audio_source["id"], "startSec": 0, "endSec": repair_durations[0],
                    "replacementText": narration_text, "languageId": "en", "voiceId": profile_ids[0],
                    "generationSettings": SETTINGS,
                }))
                video_repair = wait_job(base, request(base, "POST", project_path + "/repairs", {
                    "assetId": video_source["id"], "startSec": 0, "endSec": repair_durations[1],
                    "replacementText": narration_text, "languageId": "en", "voiceId": profile_ids[1],
                    "generationSettings": SETTINGS,
                }))
                export = wait_job(base, request(
                    base, "POST", project_path + f"/repairs/{video_repair['result']['repairId']}/exports"
                ))

                final_project = request(base, "GET", project_path)
                output_ids = {
                    *(result["result"]["outputId"] for result in narration_results),
                    audio_repair["result"]["outputId"],
                    video_repair["result"]["outputId"],
                    export["result"]["outputId"],
                }
                outputs = [item for item in final_project["outputs"] if item["id"] in output_ids]
                if len(outputs) != 5 or len(final_project["sources"]) != 2:
                    raise RuntimeError("Packaged Studio output history is incomplete.")
                downloaded = {}
                for output in outputs:
                    target = runtime / output["fileName"]
                    urllib.request.urlretrieve(base + output["contentUrl"], target)
                    downloaded[output["id"]] = target
                    subprocess.run(
                        [str(ffprobe), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(target)],
                        check=True,
                        capture_output=True,
                    )
                for narration_output in narration_outputs:
                    assert_narration_silence(downloaded[narration_output["id"]])
                if original_hashes != {source_wav.name: sha256(source_wav), source_mp4.name: sha256(source_mp4)}:
                    raise RuntimeError("Packaged Studio changed a source fixture.")
                print(json.dumps({
                    "projectId": project["id"],
                    "profiles": 2,
                    "narrationVoices": profile_ids,
                    "outputs": [item["format"] for item in outputs],
                    "videoPreviewCodecs": sorted(f"{kind}:{codec}" for kind, codec in preview_codecs),
                    "mediaTools": str(ffmpeg),
                }))
                return 0
            except Exception:
                server_log.flush()
                print(server_log_path.read_text(encoding="utf-8", errors="replace")[-5000:], file=sys.stderr)
                raise
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=10)


if __name__ == "__main__":
    raise SystemExit(main())
