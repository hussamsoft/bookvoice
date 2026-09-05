# BookVoice Linux server scaffold

Self-contained installer for the server-style deployment described in
[`../linux.md`](../linux.md): uvicorn serving the FastAPI API plus the built
frontend from `backend/static/`. No desktop shell, no MSI, no tray.

Files: `install.sh` (one-shot installer), `update.sh` (release roll + rollback),
`bookvoice.env.template`, `bookvoice.service.template`, `Dockerfile`,
`docker-compose.yml`.

Line endings in this repo are normalized to LF (`.gitattributes`), but the
executable bit is not preserved when copying through Windows filesystems —
after copying the repo to the server run:

```bash
chmod +x deploy/linux/*.sh
```

## Quickstart

```bash
sudo ./deploy/linux/install.sh            # system packages, /opt/bookvoice, systemd unit, smoke check
curl http://127.0.0.1:8000/api/health     # {"status":"ready"}
sudo nano /opt/bookvoice/etc/bookvoice.env   # set your password / public origin
sudo systemctl restart bookvoice
```

`install.sh` generates a random access password unless you pass `--password`
(it prints it once). Useful flags: `--user-unit` (systemd user unit instead of
a system one), `--cuda` (NVIDIA torch wheels), `--dir` (install root,
default `/opt/bookvoice` as root, `$HOME/bookvoice` otherwise), `--no-service`
(files only). Run non-`root` with `sudo` available and it does the right thing.

## What it does

- Checks the distro (Ubuntu 22.04+ / Debian 12+; other systemd distros proceed
  with a warning) and installs system packages: `python3-venv`, `python3-dev`,
  `ffmpeg`, `libgl1`, `libglib2.0-0`, `curl`, `rsync`.
- Installs the backend tree (`main.py`, `routes/`, `services/`, `static/`,
  `data/default_voices`, requirements) into `releases/<timestamp>/` with a
  `backend` symlink pointing at the live release.
- Copies English TTS weights into `data/models/en/` if found in the source
  checkout; skips with a note otherwise (see below).
- Builds a venv from `backend/requirements-ci.txt` (CPU torch) — or
  `backend/requirements.txt` plus `torch==2.5.1+cu121 torchaudio==2.5.1+cu121`
  with `--cuda`, exactly as `backend/requirements.txt` prescribes.
- Renders `etc/bookvoice.env` from the template (never overwrites an existing
  one — re-runs keep your edits) and a hardened systemd unit
  (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`,
  `ProtectHome=read-only`, `ReadWritePaths=` limited to the data dirs). The
  unit expands `${BOOKVOICE_HOST}`/`${BOOKVOICE_PORT}` from the env file at
  restart, so rebinding is an edit + restart, not a re-render.
- Waits for `GET /api/health` and reports; on timeout it points at
  `journalctl` (first start imports torch and can take a minute).

## What it does not do

- No TLS termination — put nginx/Caddy/cloudflared in front.
- No firewall changes, no backups, no log rotation beyond journald defaults.
- No model downloads except what the app itself does at runtime (multilingual
  TTS, EasyOCR). English TTS weights are never downloaded (see below).
- No frontend build — `backend/static/` ships a prebuilt bundle. Rebuild it
  with Node 20 only if you change frontend code (see `../linux.md`).

## Layout

```
/opt/bookvoice/            (or $HOME/bookvoice)
├── backend -> releases/<timestamp>/   # symlink flipped by update.sh
├── releases/                          # previous releases kept for rollback
├── venv/                              # python virtualenv
├── etc/bookvoice.env                  # 600, sourced via EnvironmentFile
└── data/                              # sessions, voices, models, hf, easyocr
```

## Model weights

- **English TTS** has no download path off Windows: it loads only from
  `$MODEL_DIR/en/` (presence detected by `tokenizer.json`), otherwise
  narration fails with "Local English model weights not found"
  (`backend/services/tts_service.py`). Copy `data/models/en/` from a Windows
  installation (or a Windows release payload) into `/opt/bookvoice/data/models/en/`.
  Do **not** copy a `runtime-manifest.json` alongside it — its presence makes
  `media_tools` insist on packaged Windows executables and refuse to run.
- **Multilingual (Arabic etc.)** downloads automatically (~3 GB) into
  `$DATA_DIR/hf` on first non-English narration.
- **EasyOCR** models download on first OCR use into `$DATA_DIR/easyocr`
  (routed via `EASYOCR_MODULE_PATH`).
- **Forced alignment** (word-accurate timestamps): stage once with
  `python scripts/prepare_alignment_model.py` from the repo, then copy
  `backend/data/models/alignment/<lang>/` under `$MODEL_DIR/alignment/`.

## GPU vs CPU

| | CPU (`install.sh` default) | `install.sh --cuda` |
|---|---|---|
| torch | `2.6.0+cpu` from `requirements-ci.txt` | `2.5.1+cu121` via the PyTorch index |
| Narration | minutes per short passage — functional smoke testing, not production | near-real-time with a modern NVIDIA GPU |
| EasyOCR | CPU (`OCR_USE_GPU=0`) | `OCR_USE_GPU=1` written to the env file |

The CUDA profile needs the NVIDIA driver on the host (nothing else — no
container toolkit involved for the bare-metal install).

## Firewall

The unit binds `0.0.0.0:8000` by default:

```bash
sudo ufw allow 8000/tcp
```

There is no login unless `BOOKVOICE_ACCESS_PASSWORD` is set — it always is
after a scaffold install (generated or `--password`). Loopback-only instead?
Set `BOOKVOICE_HOST=127.0.0.1` in the env file and restart.

## Reverse proxy (nginx)

The app rejects browser origins it does not know, so the proxy must announce
the real scheme and you must set `BOOKVOICE_PUBLIC_ORIGIN` to the public URL:

```nginx
server {
    listen 443 ssl;
    server_name bookvoice.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    client_max_body_size 200m;   # PDF/EPUB uploads
    proxy_read_timeout 600s;     # TTS generation runs long on CPU

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Then in `etc/bookvoice.env`:

```
BOOKVOICE_PUBLIC_ORIGIN=https://bookvoice.example.com
CORS_ORIGINS=["https://bookvoice.example.com"]
```

and `sudo systemctl restart bookvoice`. Only the paths under `/` are proxied —
the app's own origin check (`backend/services/security.py`) is the allowlist;
do not weaken it by proxying to a public hostname the env file does not name.

## Updates

```bash
sudo ./deploy/linux/update.sh                    # from the updated checkout
```

Copies a new release into `releases/<timestamp>/`, refreshes the venv from the
new requirements (profile auto-detected from the installed torch build), flips
the `backend` symlink, restarts the unit and smoke-checks. On a failed health
check it flips back to the previous release and restarts. Rollback by hand:

```bash
sudo ln -sfn /opt/bookvoice/releases/<previous> /opt/bookvoice/backend
sudo systemctl restart bookvoice
```

Old releases beyond the newest five are pruned (never the live one).

## Docker

```bash
docker compose up -d --build      # from deploy/linux/
curl http://127.0.0.1:8000/api/health
```

CPU profile only (see `Dockerfile` comments for why there is no GPU variant).
No weights are baked in: mount English weights at `/app/data/models/en` and
keep `/app/data` on the `bookvoice-data` volume (multilingual + EasyOCR models
download into it on first use). Put the password in a `bookvoice.env` file
next to `docker-compose.yml` and uncomment `env_file`.

## Troubleshooting

- **Unit fails with "Failed to set up mount namespacing"** — the kernel has no
  unprivileged user namespaces (mostly user units). Comment out
  `ProtectSystem`, `ProtectHome` and `ReadWritePaths` in the unit file
  (`systemctl edit --full bookvoice`), then `daemon-reload` + restart.
- **Health never answers** — `sudo journalctl -u bookvoice -e --no-pager | tail -50`.
  First start can take a minute (torch import + model preload). Port already
  used? `ss -ltnp | grep 8000`.
- **"Local English model weights not found"** — copy `data/models/en/` from a
  Windows install into `/opt/bookvoice/data/models/en/` (needs `tokenizer.json`).
- **Audio conversion fails** — ffmpeg missing: `sudo apt install ffmpeg`.
- **`media_tools` refuses to run / "Packaged media tool is missing"** — a
  `runtime-manifest.json` was copied into the backend dir. Delete it; on Linux
  ffmpeg/ffprobe are resolved from `PATH`.
- **Session rejected from the browser** — origin mismatch: set
  `BOOKVOICE_PUBLIC_ORIGIN` to the exact URL browsers use (scheme + host).
- **User unit dies at logout** — `sudo loginctl enable-linger <user>` once.
- **Password change signed everyone out** — expected: the signing key is
  derived from the password unless `BOOKVOICE_SECRET_KEY` is set.
