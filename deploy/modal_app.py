"""Deploy BookVoice to Modal as a scale-to-zero GPU service.

The desktop app is untouched by this file. It runs the same FastAPI app from
``backend/`` with the built UI from ``frontend/dist``, on a GPU container that
sleeps when idle, so a personal deployment usually stays inside Modal's free
monthly credit.

Setup (once):

    pip install modal
    modal setup
    modal secret create bookvoice-access BOOKVOICE_ACCESS_PASSWORD=<your password>
    modal run deploy/modal_app.py::fetch_models
    modal deploy deploy/modal_app.py

The first deploy prints the app URL. Set that URL as BOOKVOICE_PUBLIC_ORIGIN
(see ``PUBLIC_ORIGIN`` below) and deploy once more so the browser-origin check
accepts it.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import modal


APP_NAME = "bookvoice"
ROOT = Path(__file__).resolve().parent.parent

# The exact origin the browser will use, e.g. "https://you--bookvoice-web.modal.run".
# Leave empty on the first deploy, then set it and deploy again.
PUBLIC_ORIGIN = os.environ.get("BOOKVOICE_PUBLIC_ORIGIN", "")

# A10G is the cheapest GPU that comfortably holds the 3 GB of weights and is
# roughly an order of magnitude faster than CPU for this model.
GPU_KIND = os.environ.get("BOOKVOICE_MODAL_GPU", "A10G")

# The web container carries no GPU, so keeping it warm is cheap and avoids a
# cold start on every page load.
SCALEDOWN_WINDOW_SECONDS = int(os.environ.get("BOOKVOICE_MODAL_IDLE", "300"))

# The GPU worker is the expensive one. A short window lets consecutive jobs
# reuse a warm container with the weights already resident, without paying for
# long idle tails. Raise it if you generate in bursts and cold starts annoy you
# more than cost does.
GPU_SCALEDOWN_SECONDS = int(os.environ.get("BOOKVOICE_MODAL_GPU_IDLE", "60"))

DATA_VOLUME = modal.Volume.from_name("bookvoice-data", create_if_missing=True)
MODEL_VOLUME = modal.Volume.from_name("bookvoice-models", create_if_missing=True)
DATA_PATH = "/data"
MODEL_PATH = "/models"
APP_PATH = "/app"

image = (
    modal.Image.debian_slim(python_version="3.11")
    # FFmpeg/FFprobe: media_tools falls back to PATH off Windows, so the system
    # binaries are all that is needed. runtime-manifest.json is deliberately not
    # shipped, or media_tools would insist on packaged executables instead.
    .apt_install("ffmpeg", "git")
    .pip_install(
        "torch==2.6.0",
        "torchaudio==2.6.0",
        index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        "fastapi==0.139.0",
        "uvicorn==0.50.0",
        "python-dotenv==1.2.2",
        "python-multipart==0.0.32",
        "chatterbox-tts==0.1.7",
        "deep-translator==1.11.4",
        "easyocr==1.7.2",
        "pillow==12.3.0",
        "numpy==1.26.4",
        "opencv-python-headless==4.11.0.86",
        "soundfile==0.13.1",
        "huggingface_hub",
    )
    .env(
        {
            "DATA_DIR": DATA_PATH,
            "MODEL_DIR": MODEL_PATH,
            "APP_DIR": APP_PATH,
            "DEFAULT_VOICES_DIR": f"{APP_PATH}/data/default_voices",
            "BOOKVOICE_SERVER_MODE": "1",
            "BOOKVOICE_PUBLIC_ORIGIN": PUBLIC_ORIGIN,
            "TTS_DEVICE": "cuda",
            "HF_HOME": f"{MODEL_PATH}/huggingface",
        }
    )
    .add_local_dir(ROOT / "backend" / "routes", f"{APP_PATH}/routes")
    .add_local_dir(ROOT / "backend" / "services", f"{APP_PATH}/services")
    .add_local_dir(ROOT / "backend" / "data" / "default_voices", f"{APP_PATH}/data/default_voices")
    .add_local_dir(ROOT / "frontend" / "dist", f"{APP_PATH}/static")
    .add_local_file(ROOT / "backend" / "main.py", f"{APP_PATH}/main.py")
)

app = modal.App(APP_NAME, image=image)


@app.function(
    volumes={MODEL_PATH: MODEL_VOLUME},
    timeout=60 * 60,
)
def fetch_models():
    """Populate the model volume: ~3 GB of TTS weights plus the CTC aligner.

    Run this once before the first deploy. Weights live in a Volume rather than
    the image so a code change does not rebuild three gigabytes.
    """
    import torch
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file, save_file
    from transformers import AutoProcessor, AutoModelForCTC

    target = Path(MODEL_PATH) / "en"
    target.mkdir(parents=True, exist_ok=True)
    for filename in ("t3_cfg.safetensors", "s3gen.safetensors", "ve.safetensors", "tokenizer.json", "conds.pt"):
        destination = target / filename
        if destination.exists():
            print(f"[models] present: {filename}")
            continue
        print(f"[models] downloading {filename}")
        source = hf_hub_download(repo_id="ResembleAI/chatterbox", filename=filename)
        destination.write_bytes(Path(source).read_bytes())

    # CTC forced alignment, matching scripts/prepare_alignment_model.py: the
    # same wav2vec2 checkpoint stored as float16 to halve the resident size.
    alignment = Path(MODEL_PATH) / "alignment" / "en"
    if not (alignment / "model.safetensors").exists():
        print("[models] staging CTC alignment model")
        alignment.mkdir(parents=True, exist_ok=True)
        repo = "facebook/wav2vec2-base-960h"
        model = AutoModelForCTC.from_pretrained(repo)
        processor = AutoProcessor.from_pretrained(repo)
        model.half().save_pretrained(alignment, safe_serialization=True)
        processor.save_pretrained(alignment)

    MODEL_VOLUME.commit()
    print("[models] ready")


def _start_volume_committer(interval_seconds: int = 30) -> None:
    """Persist Volume writes periodically.

    Voice profiles, Studio projects and outputs are written to the Volume by
    background job threads. Volume changes only reach durable storage on
    commit, so an unexpected container shutdown between commits would lose
    them. Committing on a timer bounds that window.
    """
    import threading

    def loop() -> None:
        while True:
            time.sleep(interval_seconds)
            try:
                DATA_VOLUME.commit()
            except Exception as exc:  # noqa: BLE001 - persistence must not kill the app
                print(f"[modal] volume commit skipped: {exc}")

    threading.Thread(target=loop, name="bookvoice-volume-commit", daemon=True).start()


@app.function(
    gpu=GPU_KIND,
    volumes={DATA_PATH: DATA_VOLUME, MODEL_PATH: MODEL_VOLUME},
    scaledown_window=GPU_SCALEDOWN_SECONDS,
    timeout=60 * 60,
    max_containers=1,
)
def generate(kind: str, payload: dict) -> dict:
    """Run one generation job on a GPU, then exit.

    This is where the GPU billing lives. The container exists for the duration
    of a single narration, repair or conversion — not for the duration of
    someone's browsing session — so idle reading and typing cost nothing.
    """
    sys.path.insert(0, APP_PATH)
    os.chdir(APP_PATH)
    # Pick up staged inputs the web container just wrote.
    DATA_VOLUME.reload()

    from services import generation_gateway

    result = generation_gateway.run_remote_job(kind, payload)
    # Publish the rendered audio before the web container looks for it.
    DATA_VOLUME.commit()
    return result


def _remote_executor(kind, payload, *, cancel_check=None, progress=None):
    """Run a job on the GPU function and wait, honouring cancellation.

    Progress is coarse for remote jobs: the worker is a separate process, so
    per-window callbacks do not cross the boundary. The Studio job still
    reports queued/running/complete.
    """
    call = generate.spawn(kind, payload)
    while True:
        try:
            result = call.get(timeout=5)
        except TimeoutError:
            if cancel_check is not None and cancel_check():
                # Stop paying for work whose result is already discarded.
                call.cancel()
                raise RuntimeError(f"{kind} was cancelled.")
            continue
        if progress is not None:
            try:
                progress(1.0)
            except Exception:  # noqa: BLE001 - progress is advisory
                pass
        # See the files the worker wrote.
        DATA_VOLUME.reload()
        return result


@app.function(
    # No GPU: this container serves the UI and the API, holds Studio job state,
    # and reads and writes the Volume. Generation is handed to `generate`.
    volumes={DATA_PATH: DATA_VOLUME, MODEL_PATH: MODEL_VOLUME},
    secrets=[modal.Secret.from_name("bookvoice-access")],
    scaledown_window=SCALEDOWN_WINDOW_SECONDS,
    # Studio jobs run in an in-process thread pool and wait on the GPU worker.
    timeout=60 * 60,
    # One container only: the voice library and Studio projects are a single
    # shared tree on the Volume, and concurrent writers to the same files are
    # last-write-wins.
    max_containers=1,
)
@modal.concurrent(max_inputs=8)
@modal.asgi_app()
def web():
    """Serve the BookVoice FastAPI app, UI included."""
    sys.path.insert(0, APP_PATH)
    os.chdir(APP_PATH)
    for child in ("sessions", "voices", "studio"):
        (Path(DATA_PATH) / child).mkdir(parents=True, exist_ok=True)

    from main import app as fastapi_app
    from services import remote_execution

    remote_execution.set_executor(_remote_executor)
    _start_volume_committer()
    return fastapi_app


@app.local_entrypoint()
def main():
    print("Run `modal run deploy/modal_app.py::fetch_models` first, then `modal deploy`.")
