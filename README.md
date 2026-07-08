# BookVoice

BookVoice is a personal web application that allows users to capture images of physical book pages (via a phone or webcam), extract the text using OCR, translate it into one of 23 languages, and have it read aloud using a high-quality, voice-cloned text-to-speech (TTS) engine.

## Features

This MVP was built across three development phases:

1. **Phase 1: Core Loop (OCR & TTS)**
   - Local OCR using **EasyOCR** — models download automatically on first use, no API keys.
   - Text review and editing step.
   - Local narration via the open-source **Chatterbox (Resemble AI)** TTS engine.
   - Self-contained standalone application packaging.

2. **Phase 2: Voice Cloning**
   - Direct-from-browser microphone recording via the `MediaRecorder` API to create instant Voice Profiles.
   - Support for uploading `.wav` reference clips.
   - Zero-shot voice cloning capabilities natively integrated into the TTS generation step.

3. **Phase 3: Translation & Dubbing**
   - Built-in text translation scaffolding utilizing `deep-translator` (Google Translate free endpoint) for zero-cost operation.
   - 23 supported target languages (e.g., French, Spanish, Japanese, German, Arabic).
   - Dynamic VRAM management: The backend intelligently switches between the standard English TTS model and the Multilingual TTS model on-the-fly to prevent Out-Of-Memory (OOM) errors on 8GB GPUs.
   - Automatic cross-lingual voice cloning and dubbing.

## Technology Stack

- **Frontend**: React + Vite + plain CSS
- **Backend**: Python (FastAPI)
- **TTS Engine**: [Chatterbox by Resemble AI](https://github.com/resemble-ai/chatterbox) (local, downloaded on first run)
- **OCR Engine**: [EasyOCR](https://github.com/JaidedAI/EasyOCR) (local, downloaded on first run)
- **Translation**: `deep-translator` (Python)

## System Requirements

- **GPU**: NVIDIA GPU strongly recommended (e.g., RTX 4060 8GB) for TTS. OCR runs on CPU by default to preserve VRAM.
- **Python**: Python 3.10+
- **Node.js**: v18+ (for frontend development only)
- **Disk**: ~2–3 GB for Chatterbox + EasyOCR model weights (downloaded automatically on first use)

## Directory Structure

```text
bookvoice/
├── backend/            # FastAPI backend source code
│   ├── routes/         # API endpoints (tts, voices, translation)
│   ├── services/       # Core business logic and Chatterbox integrations
│   └── data/           # Ignored by git; stores sessions and voice profiles
├── frontend/           # React + Vite frontend source code
│   └── src/            # UI components (Camera, TextEditor, BookSession, etc.)
└── dist/               # Standalone production package
    ├── static/         # Compiled React static assets
    ├── routes/         # Copied backend routes
    ├── services/       # Copied backend services
    ├── main.py         # Entry point for serving both backend API and static frontend
    └── requirements.txt
```

## Setup & Execution

BookVoice provides a convenient `dist/` directory that contains a pre-built, self-contained version of the application. 

### 1. Install Backend Dependencies
Navigate to the `dist` directory and install the required Python packages (it is recommended to use a virtual environment like `uv` or `venv`):

```bash
cd dist
uv pip install -r requirements.txt
```

*(Note: Chatterbox requires `setuptools<70` due to a PyTorch dependency quirk. This should be handled automatically by standard installation.)*

### 2. Configure Environment Variables
Create a `.env` file in the `dist` directory (or modify the backend one):

```env
PORT=8000
CORS_ORIGINS=["http://localhost:5173", "http://localhost:4173"]

# Optional: use GPU for OCR (default is CPU to save VRAM for TTS)
OCR_USE_GPU=false
```

On first page capture, EasyOCR downloads its model weights (~100 MB). Chatterbox downloads its weights on first narration. No API keys required.

### 3. Run the Standalone Application
Start the FastAPI server from the `dist` directory. The server is configured to serve the API routes alongside the compiled frontend static files, meaning you only need to run this single command:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

Open `http://localhost:8000` in your browser.

## Development
If you wish to modify the application, work within the `frontend/` and `backend/` directories directly. `backend/` is the single source of truth for the Python app; the `dist/` folder is produced by the build script.

### Running the Frontend Dev Server
```bash
cd frontend
npm install
npm run dev
```

### Building the Standalone `dist/`
`build.py` builds the frontend, copies it into `dist/static`, assembles the
backend (`main.py`, `routes/`, `services/`) into `dist/`, and writes a clean
`requirements.txt`. It also removes stale build artifacts.

```bash
python build.py
cd dist
uvicorn main:app --port 8000
```

Open `http://localhost:8000`.

### Desktop Launcher (optional)
`Launcher.exe` starts the backend and opens it in a native window. It expects to
run from a folder containing `main.py` + `static/` (i.e. the built `dist/`). On
first run, create the Python environment with `setup_venv.bat` (installs
`requirements.txt` into a local `.venv`). The InnoSetup installer
(`installer.iss`) packages this automatically.


## Packaging (Windows installer)

`build_msi.py` produces a standard Windows MSI (`installer/BookVoice.msi`) using
the WiX Toolset binaries vendored in `tools/wix`. It installs **per-user** into
`%LocalAppData%\BookVoice` by default (writable without admin rights, so the
app can create its `.venv` and `data/` at runtime), with a proper install
wizard (folder selection, shortcuts, progress).

```bash
python build.py        # (re)generate dist/
python build_msi.py    # build installer/BookVoice.msi
```

On first launch, `Launcher.exe` bootstraps a Python virtual environment
(`setup_venv.bat`) if one does not exist, then starts the backend.

## License
BookVoice utilizes the MIT-licensed Chatterbox engine by Resemble AI.
