# Running BookVoice on Linux

A server-style deployment of BookVoice on a Linux box: uvicorn serves the
FastAPI API plus the built frontend as static files. There is no desktop shell
here — no MSI installer, no Launcher, no system tray, no bundled
`cloudflared.exe`. You manage the process yourself (systemd is shown below).

## Supported baseline

- **Distro**: Ubuntu 22.04+ / Debian 12 class.
- **Python**: 3.11+ (CI runs the test suite on 3.11; see
  `.github/workflows/ci.yml:18-21`). Check: `python3 --version`.
- **Node 20**: only needed if you rebuild the frontend bundle
  (`backend/static/` ships a prebuilt snapshot in git, so Node is optional
  until you change frontend code or want a fresh build).
- **ffmpeg**: required at runtime. Off Windows the app resolves
  `ffmpeg`/`ffprobe` via `PATH` (`shutil.which`), so the distro packages are
  enough: `sudo apt install ffmpeg`. Also make sure the checkout contains no
  `runtime-manifest.json` — its presence makes `media_tools` insist on
  packaged Windows executables and refuse to run (see
  [`deploy/README.md`](README.md), "Other hosts").

## Dependencies

Two profiles. In both cases work inside a virtualenv:

```bash
python3 -m venv .venv-linux
source .venv-linux/bin/activate
```

### CPU-only

`backend/requirements-ci.txt` mirrors `backend/requirements.txt` but pins
CPU-only torch/torchaudio wheels from the PyTorch CPU index
(`--extra-index-url https://download.pytorch.org/whl/cpu`,
`torch==2.6.0+cpu`, `torchaudio==2.6.0+cpu`) and adds `pytest==9.0.3`
(`backend/requirements-ci.txt:6-16`). This is the same install CI uses
(`.github/workflows/ci.yml:26-29`):

```bash
pip install -r backend/requirements-ci.txt
```

### NVIDIA CUDA

Install the runtime requirements, then the CUDA build of torch/torchaudio
using the index URL quoted verbatim from the comment in
`backend/requirements.txt:14-17`:

> For NVIDIA GPU support, install the CUDA build of torch/torchaudio AFTER the
> above, using the PyTorch index (match the chatterbox torch version):
> ```
> pip install torch==2.5.1+cu121 torchaudio==2.5.1+cu121 \
>     --index-url https://download.pytorch.org/whl/cu121
> ```

So, concretely:

```bash
pip install -r backend/requirements.txt
pip install torch==2.5.1+cu121 torchaudio==2.5.1+cu121 \
    --index-url https://download.pytorch.org/whl/cu121
```

(Plain PyPI `torch` wheels on Linux already bundle CUDA support; the explicit
command above is what `backend/requirements.txt` itself prescribes.)

## Frontend bundle

The FastAPI app serves a `static/` directory resolved relative to its working
directory (`STATIC_DIR = Path("static").resolve()`, `backend/main.py:159`):
when present it mounts `static/assets` at `/assets` and serves every other
GET path as a file under `static/`, falling back to `static/index.html`;
requests starting with `api/` or `sessions/` still hit the API
(`backend/main.py:162-183`). When `static/` is absent, `/` returns the JSON
stub `{"message": "BookVoice API is running (Frontend not built)"}`
(`backend/main.py:184-188`).

To rebuild the bundle (requires Node 20):

```bash
cd frontend
npm ci
npm run build
cp -r dist/* ../backend/static/
```

`npm run build` writes to `frontend/dist`; copying it over `backend/static/`
refreshes the served snapshot. Run uvicorn from the `backend/` directory so
the relative `static/` path resolves.

## Runtime layout

Environment variables read by `backend/main.py`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATA_DIR` | `data` (`main.py:51`) | Sessions and voice storage root |
| `MODEL_DIR` | `data/models` (`main.py:55`) | Local model weights root |
| `DEFAULT_VOICES_DIR` | `data/default_voices` (`main.py:52-54`) | Source of seeded default voices |
| `VOICE_DATA_DIR` | `$DATA_DIR/voices` (`main.py:63`) | Where cloned voices live |
| `APP_DIR` | current directory (`main.py:56`) | App-relative fallbacks |

Use absolute paths when running under systemd. Example layout:

```bash
sudo mkdir -p /var/lib/bookvoice/models
```

Model behavior on first use:

- **Chatterbox multilingual (Arabic etc.)** downloads automatically from
  Hugging Face the first time a non-English language is narrated
  (`ChatterboxMultilingualTTS.from_pretrained(...)`,
  `backend/services/tts_service.py:727-734`). Roughly 3 GB.
- **Chatterbox English** has *no* download path. It loads only from a local
  bundle under `$MODEL_DIR/en/` (presence detected by `tokenizer.json`,
  `tts_service.py:509-512`); otherwise narration fails with
  "Local English model weights not found" (`tts_service.py:736-740`). The
  English weights ship only in Windows release payloads, so on Linux either
  copy `data/models/en/` from a Windows installation into your `MODEL_DIR`,
  or stick to multilingual narration.
- **EasyOCR** models download on first OCR use
  (`easyocr.Reader(langs, gpu=use_gpu)` with English + Arabic defaults,
  `backend/services/ocr_service.py:17-38`).
- **Default voices** seed automatically on startup: `.wav` files in
  `DEFAULT_VOICES_DIR` are copied into the voices dir, existing files left
  alone; seeding is skipped harmlessly if the source dir is missing
  (`backend/main.py:34`, `backend/routes/voices.py:48-67`).

Stage the CTC forced-alignment model once (needs network + the venv; writes
float16 weights to `backend/data/models/alignment/en/` by default):

```bash
python scripts/prepare_alignment_model.py            # English (default)
# python scripts/prepare_alignment_model.py --language ar --repo <hf-repo>
```

Defaults come from the script itself: repo `facebook/wav2vec2-base-960h`,
language `en`, output `backend/data/models/alignment/<language>`
(`scripts/prepare_alignment_model.py:28,33-39,45`). Without it the app falls
back to estimated (not word-accurate) timestamps.

## Running

`backend/main.py` does not parse host/port env vars itself — pass them to
uvicorn. Server-mode variables (`BOOKVOICE_SERVER_MODE`,
`BOOKVOICE_ACCESS_PASSWORD`, `BOOKVOICE_PUBLIC_ORIGIN`, cookie/TLS behavior)
are documented in [`deploy/README.md`](README.md); they apply unchanged here.

From the repository root:

```bash
source .venv-linux/bin/activate
export DATA_DIR=/var/lib/bookvoice
export MODEL_DIR=/var/lib/bookvoice/models
export BOOKVOICE_SERVER_MODE=1
export BOOKVOICE_ACCESS_PASSWORD='<a long password>'
# export BOOKVOICE_PUBLIC_ORIGIN='https://bookvoice.example.com'   # behind TLS/domain
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

**LAN binding**: `--host 0.0.0.0` exposes the instance to your whole network,
and there is no login unless `BOOKVOICE_ACCESS_PASSWORD` is set. Read the LAN
warning in [`deploy/README.md`](README.md) before binding non-loopback. Put
TLS (nginx/Caddy/cloudflared) in front for anything beyond trusted-LAN use —
the session cookie is `Secure` by default and browsers discard it over plain
HTTP.

### systemd unit (user service)

`~/.config/systemd/user/bookvoice.service`:

```ini
[Unit]
Description=BookVoice server
After=network-online.target

[Service]
WorkingDirectory=%h/bookvoice/backend
ExecStart=%h/bookvoice/.venv-linux/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
Environment=DATA_DIR=/var/lib/bookvoice
Environment=MODEL_DIR=/var/lib/bookvoice/models
Environment=BOOKVOICE_SERVER_MODE=1
Environment=BOOKVOICE_ACCESS_PASSWORD=<a long password>
# Environment=BOOKVOICE_PUBLIC_ORIGIN=https://bookvoice.example.com
Restart=on-failure

# Hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=read-only
RestrictSUIDSGID=yes

[Install]
WantedBy=default.target
```

Adjust `WorkingDirectory`/paths, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now bookvoice
journalctl --user -u bookvoice -f
```

(`ProtectHome=read-only` still lets the service read the checkout; data lives
under `/var/lib/bookvoice`. If you keep data under your home directory instead,
drop that line or add a `ReadOnly=`/`ReadWritePaths=` exception.)

## Verify

1. Health endpoint:
   ```bash
   curl -fsS http://127.0.0.1:8000/api/health     # {"status":"ready"} (main.py:152-155)
   ```
2. Tests pass on Linux with the CPU profile (same command CI runs):
   ```bash
   cd <repo-root>
   python -m pytest tests -q
   ```
3. UI loads: open `http://127.0.0.1:8000/` in a browser and import a PDF
   (exercises upload, page rendering, OCR).
4. Narration smoke test: generate one short clip.
   - GPU install: expect model load in tens of seconds, then near-real-time
     generation.
   - CPU install: the app itself warns generation is "VERY slow (minutes per
     page)" (`tts_service.py:699-704`) — expect minutes per short passage.
     Treat CPU as functional smoke testing, not production narration.

## Non-goals on Linux

- No MSI/Launcher/tray integration — those are Windows packaging concerns.
- No `runtime-manifest.json` (see baseline section).
- No bundled cloudflared binary — but the tunnel feature itself works:
  `tunnel.py` resolves cloudflared from `PATH` after checking explicit/app-dir
  locations (`find_cloudflared`, `tunnel.py:123-139`, uses
  `shutil.which("cloudflared")`), and the non-Windows executable name is plain
  `cloudflared` (`tunnel.py:129`). Install it with `sudo apt install
  cloudflared` (Cloudflare's apt repo) and set `BOOKVOICE_CLOUDFLARED` only if
  it lives outside `PATH`. Tunnel flags/settings are covered in
  [`deploy/README.md`](README.md).
