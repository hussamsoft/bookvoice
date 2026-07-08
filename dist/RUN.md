# Running BookVoice (Packaged Build)

This `dist` folder is the self-contained, built version of BookVoice. The
frontend is compiled into `static/` and served directly by the FastAPI backend,
so only one process needs to run.

## Prerequisites
- Python **3.10 or 3.11** (chatterbox/torch are not validated on newer versions)
- `uv` or `venv` for the Python environment
- An NVIDIA GPU recommended for TTS (OCR runs on CPU by default to save VRAM)

## Setup
1. Open a terminal in this `dist` directory.
2. Create a virtual environment:
   ```bash
   python -m venv .venv
   .venv\Scripts\activate
   ```
3. Install the dependencies (this file is UTF-8 and pinned):
   ```bash
   pip install -r requirements.txt
   ```
   For GPU support, also install the CUDA torch wheels:
   ```bash
   pip install torch==2.5.1+cu121 torchaudio==2.5.1+cu121 --index-url https://download.pytorch.org/whl/cu121
   ```
   (Alternatively, run `setup_venv.bat` which does steps 2–3 for you.)

## Running the App
1. Start the server using Uvicorn:
   ```bash
   uvicorn main:app --port 8000
   ```
2. Open `http://localhost:8000` in your browser.
3. The server handles static files and all API calls (`/api/ocr`, `/api/tts/narrate`, etc.).

**First run:** EasyOCR and Chatterbox download their models automatically. The
first page capture and first narration each take longer while weights are fetched.

## Rebuilding
From the repo root: `python build.py` regenerates this `dist/` from `frontend/`
and `backend/`. The desktop `Launcher.exe` starts this server and opens it in a
native window.

## Installer / first run
The packaged app is installed per-user (default `%LocalAppData%\BookVoice`,
writable without admin). On first launch, `Launcher.exe` automatically creates
the Python virtual environment via `setup_venv.bat` (using `uv` if available,
otherwise the system `python`) and then starts the server. The first run
downloads the model dependencies, so it can take a few minutes.
