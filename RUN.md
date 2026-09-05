# BookVoice — run (Windows)

BookVoice runs as a portable application payload built by `build.py` into
`dist/`. It has two entry points: the desktop app and the LAN server for
phones and tablets.

## Desktop app (recommended)

1. Run **`dist\desktop\BookVoice.exe`** (pin it to the taskbar or Start menu)
2. First launch starts the bundled reading engine in the background and shows
   a splash while it warms up; the app opens in a native window when ready
3. Closing the window stops the engine

- Validates the payload (`main.py`, `static/`, bundled models) on start
- Uses bundled **Python 3.10** and application packages from `runtime\worker\`
- Creates only writable data, session, config, and log directories
- Uses the packaged CUDA PyTorch build when an NVIDIA GPU is present
- Launching it again while it runs just raises the existing window
- A `.bookvoice` file path on the command line imports and opens the book
- `BookVoice.exe --register-bookvoice` makes double-clicked `.bookvoice`
  files open in BookVoice (per-user, no admin); `--unregister-bookvoice`
  removes it again

## Server for phones and tablets (mobile web)

Run **`dist\Start-BookVoice-Server.bat`** and keep the console window open.
It prints the addresses to open in a phone or tablet browser on the same
network (`http://<computer-ip>:8000`). Ctrl+C or closing the console stops
the server.

Anyone who can reach the port gets full access unless
`BOOKVOICE_ACCESS_PASSWORD` is set.

### Ports and reaching the server without fail

- The port is dynamic: the server reuses the port it last came up on and
  only scans 8000-8020 when that port is taken, so bookmarked URLs keep
  working across restarts. Pass `--port N` (or set `BOOKVOICE_PORT`) to pin
  one.
- The Settings panel in the app shows the current addresses to open on
  another device, with copy buttons (via `GET /api/server/addresses`).
- Cloudflare Tunnel is built in:
  `Start-BookVoice-Server.bat --tunnel` publishes a fresh public URL,
  `--tunnel-name <name> --tunnel-hostname <host>` keeps one permanent
  address, and `--tunnel-token <token> --port N` runs a dashboard-managed
  tunnel (the dashboard's ingress must point at the pinned port). Settings
  persist in the runtime folder, so the desktop shell tunnels too once
  configured. The desktop shell accepts the same flags
  (`BookVoice.exe --tunnel ...`).

## What happens on first launch

- The shell validates the install (`main.py`, `static/`, bundled models)
- Uses bundled **Python 3.10** and application packages from `runtime\worker\`
- Creates only writable data, session, config, and log directories
- Uses the packaged CUDA PyTorch build when an NVIDIA GPU is present

## Logs

| Log | Location |
|-----|----------|
| Shell + launcher | `%LocalAppData%\BookVoice\installs\<id>\bookvoice_launch.log` |
| Backend | `...\bookvoice_server.log` |
| Desktop shell | `...\bookvoice_shell.log` |

## Browser mode

`BookVoice.bat` starts the same backend and opens the default browser instead
of the desktop window — useful when the WebView2 Runtime is missing. It
accepts the same flags (`--host lan`, `--port`, a `.bookvoice` path, ...).

## Developer / build artifact

The `dist/` folder is a **build output**. Regenerate it with:

```bat
python build.py
```

Manual backend start (developers):

```bat
cd dist
runtime\worker\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

## USB / fully local runtime

Set `BOOKVOICE_PORTABLE=1` before launching to keep runtime data beside the
app in `.bookvoice\` instead of `%LocalAppData%`.

## Linux

The backend runs unmodified on Linux; see [`deploy/linux/README.md`](deploy/linux/README.md)
for the installer, systemd unit, and Docker scaffold.
