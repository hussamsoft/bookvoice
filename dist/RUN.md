# BookVoice — build artifact (`dist/`)

This folder is the **build output** consumed by the Windows installers.
End users should install via `BookVoice.msi` or `BookVoice-User.msi`, not copy
this folder manually.

## Installers (recommended)

| Installer | Location | Admin required |
|-----------|----------|----------------|
| `BookVoice.msi` | Program Files | Yes (at install) |
| `BookVoice-User.msi` | `%LocalAppData%\BookVoice\App` | **No** |

Both use the same payload. First launch creates a scoped Python environment
under `%LocalAppData%\BookVoice\installs\<id>\`.

## Developer manual start

```bat
setup_venv.bat
.venv\Scripts\activate
uvicorn main:app --host 127.0.0.1 --port 8000
```

Bundled bootstrap Python (no system Python required):

```bat
runtime\python\python.exe -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

## Layout

| Path | Purpose |
|------|---------|
| `Launcher.exe` | Desktop window entry (Start Menu shortcut target) |
| `BookVoice.bat` | Browser fallback launcher |
| `launch.py` | Shared launcher logic |
| `runtime/python/` | Embeddable Python 3.10 (venv bootstrap) |
| `main.py` / `routes/` / `services/` | FastAPI backend |
| `static/` | Built React UI |
| `data/models/en/` | Bundled English TTS weights |
| `setup_venv.bat` | Create/repair `.venv` + CUDA torch |

## Notes

- Writable runtime (`.venv`, sessions, config) lives under
  `%LocalAppData%\BookVoice\installs\<install-id>\`.
- Set `BOOKVOICE_PORTABLE=1` to keep runtime beside the app (USB/dev).
- English TTS is offline once `data/models/en` is present.
