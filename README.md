# BookVoice

BookVoice is a local-first desktop and private-server app for capturing book
pages, reviewing extracted text, translating English/Arabic, and listening to
locally generated narration. The browser UI runs against a bundled FastAPI
backend; there is no hosted account system.

## Features

### Scanner and narration

- Camera/webcam capture and local EasyOCR extraction, with an editable text
  review step.
- English/Arabic translation through Google's translation service. The text
  action states that selected text is sent to Google Translate; OCR, TTS, and
  Voice Studio remain local, and BookVoice adds no telemetry.
- Local Chatterbox TTS, microphone/upload voice profiles, and saved
  voice/language defaults.
- A sleep timer, playback speed, seeking, skip controls, and OS media-key
  integration in the shared transport.

### Reader capability contract

| Status | Capability |
|---|---|
| **Supported now** | Open PDF, EPUB, TXT, MD, and `.bookvoice` books from the Reader file picker or Library; `?book=<id>` opens a prepared book. |
| **Supported now** | Reader toolbar symbols: bookmark, Previous, Next, page jump, and More. More contains mute, zoom out/in, Fit, find-in-book, bookmark jumps, contextual voice/language controls, explicit PDF OCR, and Reader book actions. |
| **Supported now** | `PlaybackControls`: play/pause, stop, seek bar, elapsed/remaining time, narration speed, and sleep timer. |
| **Supported now** | Streamed page narration, prepared page-audio playback, saved progress, server-side Library progress, and durable promotion of successful narration for a prepared book. |
| **Supported now in Reader and Library** | Prepare whole book, save `.bookvoice`, and export chaptered `.m4b`; Reader's More menu uses the same `useBookActions` contract as Library rows. |
| **Supported now, no second transport** | Leaving Reader stops its existing playback session; other views show an explicit disabled **Return to book** state rather than a second audio state machine. |
| **Supported now, measured only** | Text and PDF highlighting, click-to-pronounce, and Follow narration activate only when the backend supplies a complete monotonic word map. PDF activation is disabled with an explanation when the current page lacks timings. |
| **Supported now** | Download prepared page audio from Reader More as a single WAV or an inclusive page range ZIP with `manifest.json`; downloads do not alter narration position or reading progress. |
| **Intentionally deferred** | Pan/drag and auto-turn. |

### Voice Studio

- Persistent local projects for typed narration and imported audio/video.
- Clone a consented 5–30 second reference, or re-voice an existing recording.
- Adjust pace, expression, temperature, guidance, and repeatable seed for new
  narration.
- Correct transcript sentences and waveform phrases into immutable output
  versions; repair compatible video to H.264/AAC MP4.
- Download outputs to the current device or open the project's managed folder.

The Scanner translation action sends selected text to Google Translate. OCR,
TTS, and Voice Studio remain local. No telemetry is collected by BookVoice.

## Hosting

BookVoice is a local desktop app by default: loopback-only, no login, with
generated files downloaded by the browser using it. It can also run as a private server — see
[`deploy/README.md`](deploy/README.md) for the environment variables, the Modal
deployment, and the limits (single-tenant, no per-user separation, no quotas).

## Linux

A practical Linux server deployment (CPU or NVIDIA GPU) is documented in
[`deploy/linux.md`](deploy/linux.md), including a `scripts/setup_linux.sh`
bootstrap, model-weight notes, and a hardened systemd unit.

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

Download **`BookVoice-Launcher.exe`** from the latest GitHub release and double-click it.
The first run downloads, verifies, and installs BookVoice; every later run starts the
installed app directly — no console window, no batch files, no separate setup program.
Pin it to the taskbar or Start menu like any other app.

| Artifact | Install location | Admin at install |
|----------|------------------|------------------|
| `BookVoice-Launcher.exe` | Installs the per-user MSI by default → `%LocalAppData%\BookVoice\App` | **No** (recommended) |
| `BookVoice-User.msi` | `%LocalAppData%\BookVoice\App` | **No** |
| `BookVoice.msi` | `Program Files\BookVoice` | Yes |

Launcher flags: `--repair` forces a reinstall, `--machine` installs for all users
(elevates via UAC), `--quiet` installs silently, and `--manifest-url` points at a
different release manifest. Everything else is forwarded to the app
(`--browser`, `--host lan --allow-lan`, `--tunnel`, a `.bookvoice` file, ...). Downloads are
SHA-256-verified against the signed-in-repo `release-assets.json`.

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
versions until the project is explicitly deleted. Each project belongs to the
browser device that created or claimed it, so another computer or phone using the
same server cannot list, open, change, download, or delete it. Projects created
before version 2.2.0 remain preserved but must be claimed from the Voice Studio
start screen. Clearing all site data creates a new device identity; it does not
delete the earlier device's projects.


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
The native launcher also owns a Windows notification-area icon: minimizing the
window hides it from the taskbar without stopping the backend or configured
Cloudflare tunnel, and the icon restores or fully quits BookVoice.

### Updates

BookVoice asks GitHub once a day whether a newer release exists and shows a
banner when one does. **This is the only request BookVoice makes on its own**;
it sends no identifying information beyond what any HTTPS request carries, and
**Settings → Check for updates** turns it off. Hosted deployments
(`BOOKVOICE_SERVER_MODE`) never check, because the person viewing the UI is not
on the machine that would be restarted.

Choosing to install downloads `BookVoice-Launcher.exe` for the new tag,
verifies it against the SHA-256 in that release's `release-assets.json`, closes
BookVoice, and hands over to that installer — the same one a fresh install
uses. An older installer can also be pointed at the current release directly:

```bash
BookVoice-Launcher.exe --latest
```

> **The MSI and launcher are not code-signed.** Installing therefore raises a
> SmartScreen warning, and an all-users install raises an unsigned UAC prompt.
> Verify the SHA-256 against `SHA256SUMS.txt` on the release page if you did not
> build it yourself.

## License
BookVoice utilizes the MIT-licensed Chatterbox engine by Resemble AI.
Release builds also distribute FFmpeg/FFprobe under GPLv3; the installed
`tools/ffmpeg/NOTICE.txt` and `tools/ffmpeg/LICENSE.txt` files include the
applicable attribution, license, and corresponding-source locations.
