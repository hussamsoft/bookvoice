# Hosting BookVoice

BookVoice is built as a Windows desktop app: it binds to loopback, needs no
login, saves into your Downloads folder, and opens project folders in Explorer.
Hosting it means turning those assumptions off. Everything here is opt-in — with
none of these environment variables set, the desktop app behaves exactly as
before.

## Environment variables

| Variable | Effect |
|----------|--------|
| `BOOKVOICE_SERVER_MODE` | `1` marks this as a hosted server. Hides Save-to-Downloads and Open Folder in the UI, and refuses them server-side. |
| `BOOKVOICE_ACCESS_PASSWORD` | Enables the password gate. Unset means no login — never do that on a public URL. |
| `BOOKVOICE_PUBLIC_ORIGIN` | The exact origin the browser uses, e.g. `https://you--bookvoice-web.modal.run`. Without it the loopback-only origin check rejects every API call. |
| `BOOKVOICE_SECRET_KEY` | Optional session signing key. Defaults to a key derived from the password, so changing the password signs everyone out. |
| `BOOKVOICE_COOKIE_SECURE` | Set to `0` only for local plain-HTTP testing. |

Sessions are a signed cookie with a 30-day lifetime. There is no server-side
session store, so there is nothing to clean up and no state to lose.

## Modal (recommended)

Modal bills per second and scales to zero, so you pay only while audio is
actually being generated. The free Starter plan includes $30/month in credits,
which for one person's use is usually the whole bill.

```bash
pip install modal
modal setup

# 1. Store the access password
modal secret create bookvoice-access BOOKVOICE_ACCESS_PASSWORD='<a long password>'

# 2. Build the UI (the image ships frontend/dist as the static payload)
cd frontend && npm ci && npm run build && cd ..

# 3. Populate the model volume — ~3 GB, once
modal run deploy/modal_app.py::fetch_models

# 4. Deploy
modal deploy deploy/modal_app.py
```

The deploy prints a URL. Set it as the public origin and deploy again so the
browser-origin check accepts it:

```bash
export BOOKVOICE_PUBLIC_ORIGIN="https://you--bookvoice-web.modal.run"
modal deploy deploy/modal_app.py
```

### Why it is shaped this way

- **Weights live in a Volume, not the image.** Three gigabytes in an image layer
  means every code change rebuilds three gigabytes. `fetch_models` runs once.
- **One container maximum.** The voice library and Studio projects are a single
  shared tree; Modal Volumes are last-write-wins on concurrent modification of
  the same file, so a second writer would corrupt project manifests.
- **Volume commits run on a timer.** Studio jobs write from background threads,
  and Volume writes only become durable on commit. A 30-second commit loop
  bounds what an unexpected shutdown can lose.
- **Idle window of 5 minutes.** Long enough that a working session does not pay
  repeated cold starts, short enough that idle time is not billed. Raise it with
  `BOOKVOICE_MODAL_IDLE` if cold starts annoy you more than cost does.

### Cold starts

The first request after idle loads ~3 GB of weights from the Volume onto the
GPU. Expect roughly 30–60 seconds. Subsequent requests are warm until the
scaledown window expires.

## Other hosts

Any Linux box with an NVIDIA GPU works — the app already falls back to
`shutil.which` for FFmpeg off Windows, so system `ffmpeg`/`ffprobe` is enough.
Do **not** ship `runtime-manifest.json` to a Linux host: its presence makes
`media_tools` insist on packaged Windows executables and refuse to run.

Serve it with:

```bash
DATA_DIR=/var/lib/bookvoice \
MODEL_DIR=/var/lib/bookvoice/models \
BOOKVOICE_SERVER_MODE=1 \
BOOKVOICE_ACCESS_PASSWORD='<a long password>' \
BOOKVOICE_PUBLIC_ORIGIN='https://bookvoice.example.com' \
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Put TLS in front of it. The session cookie is `Secure` by default and browsers
will discard it over plain HTTP.

Always-on GPU rental runs roughly $245–360/month for an RTX 4090, which is why
serverless is the better fit unless the app is genuinely busy.

## What hosting does not give you

- **It is single-tenant.** The voice library and every Studio project are
  global. Anyone who signs in sees, uses and can delete everyone's voices and
  projects. The password gates access to the whole instance, not per person.
- **No quota or rate limiting.** One signed-in person can occupy the GPU
  indefinitely. Fine for personal use; not a public demo.
- **Prepared-book and Studio storage grows without bound.** Sources are copied
  and every output version is kept until a project is deleted. Watch the Volume.
