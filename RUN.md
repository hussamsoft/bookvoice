# BookVoice — install and run (Windows)

BookVoice ships as Windows installers built from the same `dist/` payload.

## Recommended install (no admin)

1. Run **`BookVoice-User.msi`**
2. Installs to `%LocalAppData%\BookVoice\App` (writable, no administrator prompt)
3. Launch **BookVoice** from the Start Menu or desktop shortcut
4. First launch creates a scoped Python environment and installs dependencies (several minutes)

## Standard install (all users)

1. Run **`BookVoice.msi`** (admin required during install)
2. Installs to `Program Files\BookVoice`
3. Writable runtime still lives under `%LocalAppData%\BookVoice\installs\<id>\`

## What happens on first launch

- The launcher validates the install (`main.py`, `static/`, bundled models)
- Creates/reuses a venv under `%LocalAppData%\BookVoice\installs\<install-id>\.venv`
- Uses bundled **Python 3.10** from `runtime\python\` (no system Python required)
- Upgrades to CUDA PyTorch automatically when an NVIDIA GPU is present
- Opens a desktop window (or browser via `BookVoice.bat --browser`)

## Logs

| Log | Location |
|-----|----------|
| Launcher | `%LocalAppData%\BookVoice\installs\<id>\bookvoice_launch.log` |
| Venv setup | `...\bookvoice_setup.log` |
| Backend | `...\bookvoice_server.log` |

## Developer / build artifact

The `dist/` folder is a **build output**, not an end-user portable package.
Regenerate it with:

```bat
python build.py --msi --per-user
```

Manual backend start (developers):

```bat
cd dist
runtime\python\python.exe -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

## USB / fully local runtime

Set `BOOKVOICE_PORTABLE=1` before launching to keep runtime data beside the app
in `.bookvoice\` instead of `%LocalAppData%`.

## Deprecated

Copying the `dist/` folder manually is no longer supported for end users.
Use `BookVoice-User.msi` instead.
