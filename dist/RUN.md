# BookVoice — build artifact (`dist/`)

This folder is the **build output** consumed by the Windows installers.
End users should install via `BookVoice.msi` or `BookVoice-User.msi`, not copy
this folder manually.

## Installers (recommended)

| Installer | Location | Admin required |
|-----------|----------|----------------|
| `BookVoice.msi` | Program Files | Yes (at install) |
| `BookVoice-User.msi` | `%LocalAppData%\BookVoice\App` | **No** |

Both use the same self-contained payload. First launch only creates writable
data and log directories under `%LocalAppData%\BookVoice\installs\<id>\`.

## Developer manual start

```bat
runtime\worker\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

## Layout

| Path | Purpose |
|------|---------|
| `Launcher.exe` | Desktop window entry (Start Menu shortcut target) |
| `BookVoice.bat` | Browser fallback launcher |
| `launch.py` | Shared launcher logic |
| `runtime/worker/` | Portable Python 3.10 + locked application packages |
| `main.py` / `routes/` / `services/` | FastAPI backend |
| `static/` | Built React UI |
| `data/models/en/` | Bundled English TTS weights |

## Notes

- Writable runtime (sessions, config, logs) lives under
  `%LocalAppData%\BookVoice\installs\<install-id>\`.
- Set `BOOKVOICE_PORTABLE=1` to keep runtime beside the app (USB/dev).
- English TTS is offline once `data/models/en` is present.
