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
   - Follow-along PDF highlighting with click-to-pronounce, bookmarks, search, and continue-reading.
   - Playback progress, seeking, speed control, skip controls, and page-audio export.
   - Desktop launcher binds to **localhost only** (not exposed on the LAN).

4. **Voice Studio**
   - Persistent local projects for narration written directly in BookVoice; no text-file import is required.
   - Create Narration starts with direct WAV, MP3, M4A/AAC, FLAC, OGG, WebM, MP4, MOV, or MKV import. Select 5–30 seconds of one speaker, confirm ownership/permission, and the resulting cloned profile is automatically selected to narrate whatever you type.
   - Video imports receive a local H.264/AAC preview for reliable in-app picture and sound, while standalone narration adds short head and tail silence to protect speech from playback cutoffs.
   - Descriptive pace, expression, temperature, guidance, and optional seed controls for English and Arabic narration. Pace preserves pitch, and the interface explains the result of increasing or decreasing every value.
   - Transcript-guided sentence correction and waveform-guided phrase replacement create new immutable WAV output versions while preserving the source.
   - Repaired video exports use the original video stream when compatible and otherwise produce a broadly compatible H.264/AAC MP4.
   - Generated outputs save directly to the Windows Downloads folder without overwriting existing files, and each project can open its complete managed folder from the project list.

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
    ├── tools/ffmpeg/   # Pinned FFmpeg/FFprobe, license, and distribution notice
    └── requirements.txt
```

## Setup & Execution (Windows)

End users should install via MSI, not copy the `dist/` folder.

| Installer | Install location | Admin at install |
|-----------|------------------|------------------|
| `BookVoice-User.msi` | `%LocalAppData%\BookVoice\App` | **No** (recommended) |
| `BookVoice.msi` | `Program Files\BookVoice` | Yes |

See [RUN.md](RUN.md) for first-launch behavior, logs, and troubleshooting.

Build both installers from source:

```bash
python build.py --msi --per-user
```

Output: `installer/BookVoice.msi`, `installer/BookVoice-User.msi`, and `dist/` (build artifact).

### Developer manual run

```bash
cd dist
runtime/worker/python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Or from repo root: `python launch.py --browser`

## Development
If you wish to modify the application, work within the `frontend/` and `backend/` directories directly. `backend/` is the single source of truth for the Python app; the `dist/` folder is produced by the build script.

### Running the Frontend Dev Server
```bash
cd frontend
npm install
npm run dev
```

### Building the release package

`build.py` produces the shared install payload and optional MSI installers:

- Frontend → `dist/static`
- Backend → `dist/main.py`, `routes/`, `services/`
- Portable Python 3.10 worker and locked packages → `dist/runtime/worker`
- Bundled English models, default voices, `launch.py`, `Launcher.exe`
- Pinned FFmpeg/FFprobe 8.1.1 and license notices → `dist/tools/ffmpeg`

```bash
python build.py                 # dist/ only
python build.py --msi           # dist/ + BookVoice.msi
python build.py --msi --per-user  # dist/ + both MSIs
```

Validate an install directory:

```bash
python scripts/smoke_launch.py --app-dir dist --skip-server
```

PDF reading position, bookmarks, zoom and playback speed are stored locally in
the app browser profile. Translation uses the `deep-translator` Google backend
and therefore sends the selected page text to that external service; narration,
OCR, PDF viewing, voice profiling, and Voice Studio media processing otherwise
run locally from the bundled runtime. Voice Studio projects are stored under the
BookVoice user-data directory and keep copied sources and immutable output
versions until the project is explicitly deleted.


## Packaging (Windows installers)

`build_msi.py` produces Windows MSIs using the vendored WiX Toolset in `tools/wix`:

| MSI | Scope | Default location |
|-----|-------|------------------|
| `BookVoice.msi` | perMachine | Program Files |
| `BookVoice-User.msi` | perUser | `%LocalAppData%\BookVoice\App` |

Both ship the same self-contained `dist/` payload. Writable sessions, config,
and logs are created under `%LocalAppData%\BookVoice\installs\<install-id>\`.

```bash
python build.py --msi --per-user
```

On first launch, `Launcher.exe` verifies and starts the bundled worker. It never
creates a venv or invokes pip, and no system Python on PATH is required.

## License
BookVoice utilizes the MIT-licensed Chatterbox engine by Resemble AI.
Release builds also distribute FFmpeg/FFprobe under GPLv3; the installed
`tools/ffmpeg/NOTICE.txt` and `tools/ffmpeg/LICENSE.txt` files include the
applicable attribution, license, and corresponding-source locations.
