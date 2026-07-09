# BookVoice

BookVoice is a personal web application that allows users to capture images of physical book pages (via a phone or webcam) or open a PDF, extract the text using OCR, translate between **English and Arabic**, and have it read aloud using a high-quality, voice-cloned text-to-speech (TTS) engine.

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

3. **Phase 3: Translation & Dubbing (English + Arabic)**
   - Built-in translation via `deep-translator` (Google Translate free endpoint).
   - Supported languages: **English** and **Arabic** only.
   - Dynamic VRAM management: switches between the English TTS model and the Multilingual model (for Arabic) to reduce OOM risk on 8GB GPUs.
   - PDF mode: embedded text layer when available; **OCR fallback** for scanned pages.
   - Desktop launcher binds to **localhost only** (not exposed on the LAN).

## Technology Stack

- **Frontend**: React + Vite + plain CSS
- **Backend**: Python (FastAPI)
- **TTS Engine**: [Chatterbox by Resemble AI](https://github.com/resemble-ai/chatterbox) — English weights can be bundled under `data/models/en`; Arabic uses the multilingual model (downloaded on first Arabic narration if not bundled)
- **OCR Engine**: [EasyOCR](https://github.com/JaidedAI/EasyOCR) (English + Arabic; models download on first OCR use)
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
uvicorn main:app --host 127.0.0.1 --port 8000
```

Open `http://localhost:8000` in your browser. The desktop launcher also binds to `127.0.0.1` only.

## Development
If you wish to modify the application, work within the `frontend/` and `backend/` directories directly. `backend/` is the single source of truth for the Python app; the `dist/` folder is produced by the build script.

### Running the Frontend Dev Server
```bash
cd frontend
npm install
npm run dev
```

### Building the Standalone `dist/`
`build.py` produces a complete portable package (same payload as the MSI):

- Frontend → `dist/static`
- Backend → `dist/main.py`, `routes/`, `services/`
- Bundled English models, default voices, `setup_venv.bat`, `fix_cuda_torch.bat`
- Rebuilt `Launcher.exe`

```bash
python build.py          # portable dist/
python build.py --msi    # dist/ + installer/BookVoice.msi
```

Run portable: double-click `dist/Launcher.exe`  
Or manual: `cd dist && setup_venv.bat && uvicorn main:app --host 127.0.0.1 --port 8000`

`Launcher.exe` uses `%LocalAppData%\BookVoice` for the writable `.venv` and
session data (same as MSI). It will upgrade a CPU-only torch install to CUDA
when an NVIDIA GPU is present.


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
