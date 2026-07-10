#!/usr/bin/env python3
"""
BookVoice build script.

Produces a complete portable package in dist/ that matches MSI content:
  - React frontend → dist/static
  - FastAPI backend → dist/main.py, routes/, services/
  - requirements.txt, setup_venv.bat, fix_cuda_torch.bat
  - default voices + bundled English model weights
  - Launcher.exe (rebuilt from launch.py via PyInstaller)
  - bookvoice.ico, RUN.md

Run from the repo root:  python build.py
Full release (dist + MSI):  python build.py --msi
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Windows consoles often default to cp1252; keep arrows/ellipses printable.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except OSError:
            pass

ROOT = Path(__file__).resolve().parent
FRONTEND = ROOT / "frontend"
BACKEND = ROOT / "backend"
DIST = ROOT / "dist"

REQUIREMENTS = """\
fastapi==0.139.0
uvicorn==0.50.0
python-dotenv==1.2.2
python-multipart==0.0.32
chatterbox-tts==0.1.7
deep-translator==1.11.4
easyocr==1.7.2
pillow==12.3.0
numpy==1.26.4
opencv-python-headless==4.11.0.86
soundfile==0.13.1
setuptools<70

# CUDA torch is installed automatically by setup_venv.bat / fix_cuda_torch.bat
# when an NVIDIA GPU is detected. Manual install:
#   pip install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu124
"""

RUN_MD = """# BookVoice — portable package (`dist/`)

This folder is a complete BookVoice app, same contents the MSI installs.

## Quick start (recommended)

1. Double-click **`Launcher.exe`**
2. On first run it creates a Python env under `%LocalAppData%\\BookVoice` and
   installs CUDA PyTorch if you have an NVIDIA GPU (can take several minutes).
3. The app opens in a desktop window on `http://127.0.0.1:<port>`.

## Manual start (developers)

```bat
setup_venv.bat
.venv\\Scripts\\activate
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
  `%LocalAppData%\\BookVoice` — same as the MSI install.
- User settings (voice, language, GPU options) persist in
  `%LocalAppData%\\BookVoice\\data\\config.json`, shared by MSI and portable.
- For a fully self-contained portable data folder next to the app, set
  environment variable `BOOKVOICE_PORTABLE=1` before launching.
- English TTS is offline once `data/models/en` is present. Arabic may download
  the multilingual model on first use.
"""


def _exe(name: str) -> str:
    if sys.platform.startswith("win"):
        for candidate in (name + ".cmd", name + ".bat", name + ".exe"):
            if shutil.which(candidate):
                return candidate
    return name


def run(cmd, cwd, check=True):
    resolved = [_exe(cmd[0]) if i == 0 else c for i, c in enumerate(cmd)]
    print(f"[build] {' '.join(str(c) for c in resolved)}  (cwd={cwd})")
    return subprocess.run(resolved, cwd=str(cwd), check=check)


def copytree(src: Path, dst: Path):
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def copy_py_dir(src: Path, dst: Path):
    dst.mkdir(parents=True, exist_ok=True)
    for old in dst.glob("**/*.pyc"):
        old.unlink()
    for old in dst.glob("**/__pycache__"):
        shutil.rmtree(old, ignore_errors=True)
    # Remove stale .py files no longer in source
    for f in dst.glob("*.py"):
        if not (src / f.name).exists():
            f.unlink()
    for f in src.glob("*.py"):
        shutil.copy2(f, dst / f.name)


def build_frontend():
    if not (FRONTEND / "node_modules").exists():
        run(["npm", "install"], FRONTEND)
    else:
        run(["npm", "ci"], FRONTEND)
    run(["npm", "run", "build"], FRONTEND)


def assemble_dist():
    DIST.mkdir(exist_ok=True)

    # Preserve Launcher.exe if present until we rebuild it later
    existing_launcher = DIST / "Launcher.exe"
    launcher_backup = None
    if existing_launcher.exists():
        launcher_backup = ROOT / "build" / "_Launcher.exe.bak"
        launcher_backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(existing_launcher, launcher_backup)

    fe_build = FRONTEND / "dist"
    if not fe_build.exists():
        raise SystemExit("Frontend build output missing: " + str(fe_build))
    copytree(fe_build, DIST / "static")

    shutil.copy2(BACKEND / "main.py", DIST / "main.py")
    copy_py_dir(BACKEND / "routes", DIST / "routes")
    copy_py_dir(BACKEND / "services", DIST / "services")

    (DIST / "requirements.txt").write_text(REQUIREMENTS, encoding="utf-8")
    (DIST / "RUN.md").write_text(RUN_MD, encoding="utf-8")
    shutil.copy2(ROOT / "VERSION", DIST / "VERSION")

    # No .env in the package: the MSI already excludes it, and user settings
    # now live in %LocalAppData%\BookVoice\data\config.json. Keep an example
    # for developers who run uvicorn manually.
    env_example = DIST / ".env.example"
    env_example.write_text('CORS_ORIGINS=["*"]\nOCR_USE_GPU=false\n', encoding="utf-8")
    env = DIST / ".env"
    if env.exists():
        env.unlink()

    for name in ("setup_venv.bat", "fix_cuda_torch.bat", "BookVoice.bat"):
        src = ROOT / name
        if src.is_file():
            shutil.copy2(src, DIST / name)

    # Portable bat uses this helper to terminate the full stale uvicorn tree.
    scripts_src = ROOT / "scripts" / "kill_stale_bookvoice.ps1"
    if scripts_src.is_file():
        scripts_dst = DIST / "scripts"
        scripts_dst.mkdir(parents=True, exist_ok=True)
        shutil.copy2(scripts_src, scripts_dst / "kill_stale_bookvoice.ps1")

    ico = ROOT / "bookvoice.ico"
    if ico.is_file():
        shutil.copy2(ico, DIST / "bookvoice.ico")

    voices_src = ROOT / "voices"
    if voices_src.is_dir():
        default_voices_dst = DIST / "data" / "default_voices"
        default_voices_dst.mkdir(parents=True, exist_ok=True)
        for wav in voices_src.glob("*.wav"):
            shutil.copy2(wav, default_voices_dst / wav.name)

    models_src = BACKEND / "data" / "models"
    if models_src.is_dir():
        models_dst = DIST / "data" / "models"
        print(f"[build] Copying bundled model weights from {models_src} → {models_dst}")
        copytree(models_src, models_dst)
    else:
        print("[build] WARNING: backend/data/models missing — TTS will fail offline")

    # Clean confusing stale artifacts. data/voices and data/sessions are
    # runtime state (%LocalAppData%), not package payload — the MSI excludes
    # them, so the portable dist must not ship them either.
    for stale in (
        DIST / "index.html",
        DIST / "assets",
        DIST / "favicon.svg",
        DIST / "icons.svg",
        DIST / "data" / "voices",
        DIST / "data" / "sessions",
    ):
        if stale.is_file():
            stale.unlink()
        elif stale.is_dir():
            shutil.rmtree(stale, ignore_errors=True)
    for pycache in DIST.rglob("__pycache__"):
        shutil.rmtree(pycache, ignore_errors=True)
    for log in DIST.glob("*.log"):
        log.unlink()

    return launcher_backup


def build_launcher(launcher_backup: Path | None):
    """Rebuild Launcher.exe into dist/ without clobbering the rest of dist."""
    spec = ROOT / "Launcher.spec"
    if not spec.exists():
        print("[build] Launcher.spec missing — keeping previous Launcher.exe if any")
        if launcher_backup and launcher_backup.exists():
            shutil.copy2(launcher_backup, DIST / "Launcher.exe")
        return

    out_dir = ROOT / "build" / "pyinstaller"
    work_dir = out_dir / "work"
    dist_dir = out_dir / "dist"
    out_dir.mkdir(parents=True, exist_ok=True)

    pyinstaller = shutil.which("pyinstaller") or shutil.which("pyinstaller.exe")
    if not pyinstaller:
        # try python -m PyInstaller
        print("[build] Building Launcher via python -m PyInstaller …")
        cmd = [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            f"--distpath={dist_dir}",
            f"--workpath={work_dir}",
            str(spec),
        ]
    else:
        cmd = [
            pyinstaller,
            "--noconfirm",
            "--clean",
            f"--distpath={dist_dir}",
            f"--workpath={work_dir}",
            str(spec),
        ]

    try:
        subprocess.run(cmd, cwd=str(ROOT), check=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"[build] WARNING: Launcher rebuild failed: {e}")
        if launcher_backup and launcher_backup.exists():
            shutil.copy2(launcher_backup, DIST / "Launcher.exe")
            print("[build] Restored previous Launcher.exe")
        return

    built = dist_dir / "Launcher.exe"
    if built.is_file():
        shutil.copy2(built, DIST / "Launcher.exe")
        print(f"[build] Launcher.exe → dist/ ({built.stat().st_size // 1024} KB)")
    elif launcher_backup and launcher_backup.exists():
        shutil.copy2(launcher_backup, DIST / "Launcher.exe")
        print("[build] Restored previous Launcher.exe (new build missing)")


def validate():
    errors = []
    index = DIST / "static" / "index.html"
    if not index.is_file():
        errors.append("static/index.html missing")
    else:
        text = index.read_text(encoding="utf-8")
        refs = re.findall(r'(?:src|href)="(/assets/[^"]+)"', text)
        for r in refs:
            if not (DIST / "static" / r.lstrip("/")).exists():
                errors.append(f"missing asset {r}")
        print(f"[build] validated {len(refs)} static asset ref(s)")

    required = [
        "main.py",
        "VERSION",
        "requirements.txt",
        "setup_venv.bat",
        "fix_cuda_torch.bat",
        "BookVoice.bat",
        "scripts/kill_stale_bookvoice.ps1",
        "Launcher.exe",
        "routes/tts.py",
        "routes/voices.py",
        "routes/config.py",
        "services/tts_service.py",
        "services/config_service.py",
        "services/path_utils.py",
        "static/index.html",
        "data/models/en/tokenizer.json",
        "data/models/en/t3_cfg.safetensors",
        "data/default_voices",
    ]
    for rel in required:
        p = DIST / rel
        if not p.exists():
            errors.append(f"required missing: {rel}")

    # Parity with the MSI payload: no runtime state in the package
    for forbidden in (".env", "data/voices", "data/sessions"):
        if (DIST / forbidden).exists():
            errors.append(f"stale runtime artifact in dist: {forbidden}")

    # No stale hashed assets left only if index points at them — already checked

    if errors:
        raise SystemExit("Build validation failed:\n  - " + "\n  - ".join(errors))
    print("[build] dist package validation OK")


def build_msi():
    print("[build] Building MSI …")
    run([sys.executable, str(ROOT / "build_msi.py")], ROOT)


def main():
    parser = argparse.ArgumentParser(description="Build BookVoice portable dist/")
    parser.add_argument(
        "--msi", action="store_true", help="Also build installer/BookVoice.msi"
    )
    parser.add_argument(
        "--skip-frontend", action="store_true", help="Skip npm build (reuse frontend/dist)"
    )
    parser.add_argument(
        "--skip-launcher", action="store_true", help="Skip PyInstaller launcher rebuild"
    )
    args = parser.parse_args()

    print("[build] Building BookVoice portable dist/ …")
    if not args.skip_frontend:
        build_frontend()
    else:
        print("[build] Skipping frontend build")

    launcher_backup = assemble_dist()

    if not args.skip_launcher:
        build_launcher(launcher_backup)
    elif launcher_backup and launcher_backup.exists():
        shutil.copy2(launcher_backup, DIST / "Launcher.exe")

    # Also mirror static into backend/static for dev uvicorn-from-backend
    backend_static = BACKEND / "static"
    if (DIST / "static").is_dir():
        copytree(DIST / "static", backend_static)

    validate()
    print("[build] Portable package ready: dist/  (run Launcher.exe)")

    if args.msi:
        build_msi()
        print("[build] MSI ready: installer/BookVoice.msi (+ cab*.cab)")


if __name__ == "__main__":
    main()
