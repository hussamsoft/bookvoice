# BookVoice — portable package (`dist/`)

This folder is a complete BookVoice app, same contents the MSI installs.

## Quick start (recommended)

1. Double-click **`Launcher.exe`**
2. On first run it creates a Python env under `%LocalAppData%\BookVoice` and
   installs CUDA PyTorch if you have an NVIDIA GPU (can take several minutes).
3. The app opens in a desktop window on `http://127.0.0.1:<port>`.

## Manual start (developers)

```bat
setup_venv.bat
.venv\Scripts\activate
uvicorn main:app --host 127.0.0.1 --port 8000
```

Then open http://127.0.0.1:8000

If TTS is slow, force GPU torch:

```bat
fix_cuda_torch.bat
```

## Layout

| Path | Purpose |
|------|---------|
| `BookVoice.bat` | **Reliable portable start** (browser; preferred if EXE fails) |
| `Launcher.exe` | Desktop window entry (same backend env as the .bat) |
| `main.py` / `routes/` / `services/` | FastAPI backend |
| `static/` | Built React UI |
| `data/models/en/` | Bundled English TTS weights |
| `data/default_voices/` | Seed voice profiles |
| `setup_venv.bat` | Create/repair `.venv` + CUDA torch |
| `fix_cuda_torch.bat` | Upgrade an existing venv to CUDA torch |

## Notes

- Writable data (sessions, custom voices, `.venv`) lives in
  `%LocalAppData%\BookVoice` — same as the MSI install.
- For a fully self-contained portable data folder next to the app, set
  environment variable `BOOKVOICE_PORTABLE=1` before launching.
- English TTS is offline once `data/models/en` is present. Arabic may download
  the multilingual model on first use.
