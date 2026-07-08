#!/usr/bin/env python3
"""
BookVoice build script.

Single source of truth for producing the self-contained `dist/` app:
  - Builds the React frontend (npm) into frontend/dist
  - Copies the compiled frontend into dist/static
  - Copies the FastAPI backend (main.py, routes/, services/) into dist/
  - Writes a clean UTF-8, pinned requirements.txt
  - Removes stale root-level index.html / assets stubs

Run from the repo root:  python build.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FRONTEND = ROOT / "frontend"
BACKEND = ROOT / "backend"
DIST = ROOT / "dist"

# Pinned Python dependencies (frontend deps are managed by npm).
# torch/torchaudio are intentionally NOT pinned here: chatterbox-tts pulls a
# CPU build by default, and the CUDA wheels must be installed from the PyTorch
# index. See the comment block written into requirements.txt.
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
setuptools<70

# For NVIDIA GPU support, install the CUDA build of torch/torchaudio AFTER the
# above, using the PyTorch index (match the chatterbox torch version):
#   pip install torch==2.5.1+cu121 torchaudio==2.5.1+cu121 \\
#       --index-url https://download.pytorch.org/whl/cu121
"""


def _exe(name: str) -> str:
    """Resolve an executable that may be a .cmd/.bat shim on Windows."""
    if sys.platform.startswith("win"):
        import shutil
        for candidate in (name + ".cmd", name + ".bat", name + ".exe"):
            if shutil.which(candidate):
                return candidate
    return name


def run(cmd, cwd):
    resolved = [_exe(cmd[0]) if i == 0 else c for i, c in enumerate(cmd)]
    print(f"[build] {' '.join(str(c) for c in resolved)}  (cwd={cwd})")
    subprocess.run(resolved, cwd=str(cwd), check=True)


def copytree(src: Path, dst: Path):
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def copy_py_dir(src: Path, dst: Path):
    dst.mkdir(parents=True, exist_ok=True)
    # Remove stale .pyc caches in the destination
    for old in dst.glob("**/*.pyc"):
        old.unlink()
    for old in dst.glob("**/__pycache__"):
        shutil.rmtree(old, ignore_errors=True)
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

    # 1. Frontend static assets
    fe_build = FRONTEND / "dist"
    if not fe_build.exists():
        raise SystemExit("Frontend build output missing: " + str(fe_build))
    static_dst = DIST / "static"
    copytree(fe_build, static_dst)

    # 2. Backend code (single source of truth = backend/)
    shutil.copy2(BACKEND / "main.py", DIST / "main.py")
    copy_py_dir(BACKEND / "routes", DIST / "routes")
    copy_py_dir(BACKEND / "services", DIST / "services")

    # 3. Requirements (UTF-8, pinned)
    (DIST / "requirements.txt").write_text(REQUIREMENTS, encoding="utf-8")

    # 4. .env from example if absent
    env = DIST / ".env"
    if not env.exists():
        shutil.copy2(DIST / ".env.example", env)

    # 5. venv bootstrap script used by the launcher / installer
    shutil.copy2(ROOT / "setup_venv.bat", DIST / "setup_venv.bat")

    # 6. Preloaded default voices (seeded into data/voices at runtime by the API)
    voices_src = ROOT / "voices"
    if voices_src.is_dir():
        default_voices_dst = DIST / "data" / "default_voices"
        default_voices_dst.mkdir(parents=True, exist_ok=True)
        for wav in voices_src.glob("*.wav"):
            shutil.copy2(wav, default_voices_dst / wav.name)

    # 5. Remove stale root-level artifacts that cause confusion
    stale_root_index = DIST / "index.html"
    if stale_root_index.exists():
        stale_root_index.unlink()
    stale_assets = DIST / "assets"
    if stale_assets.exists() and stale_assets.is_dir():
        shutil.rmtree(stale_assets, ignore_errors=True)


def validate():
    index = DIST / "static" / "index.html"
    text = index.read_text(encoding="utf-8")
    import re
    refs = re.findall(r'(?:src|href)="(/assets/[^"]+)"', text)
    missing = [r for r in refs if not (DIST / "static" / r.lstrip("/")).exists()]
    if missing:
        raise SystemExit("Build validation failed, missing assets: " + ", ".join(missing))
    print(f"[build] validated {len(refs)} referenced static asset(s)")


def main():
    print("[build] Building BookVoice dist/ ...")
    build_frontend()
    assemble_dist()
    validate()
    print("[build] Done. Run with:  cd dist && uvicorn main:app --port 8000")


if __name__ == "__main__":
    main()
