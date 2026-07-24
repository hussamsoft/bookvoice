#!/usr/bin/env python3
"""
BookVoice build script.

Produces the release package in dist/ (same payload as both MSI variants):
  - React frontend → dist/static
  - FastAPI backend → dist/main.py, routes/, services/
  - Immutable Python worker runtime → dist/runtime/worker
  - runtime manifest, requirements provenance, launch.py
  - default voices + bundled English model weights
  - Launcher.exe (rebuilt from launch.py via PyInstaller)

Run from the repo root:  python build.py
Full release:  python build.py --msi --per-user
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
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


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_fingerprint(root: Path, excluded_top_level: set[str] | None = None) -> str:
    """Hash relative paths and bytes for deterministic release provenance."""
    excluded = excluded_top_level or set()
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        relative = path.relative_to(root)
        if relative.parts and relative.parts[0] in excluded:
            continue
        if "__pycache__" in relative.parts or path.suffix in {".pyc", ".pyo"}:
            continue
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def fixed_loopback_assets(static_dir: Path) -> list[str]:
    """Return built JS assets that would bypass the launcher's selected origin."""
    forbidden = (b"http://localhost:8000", b"http://127.0.0.1:8000")
    offenders = []
    for asset in sorted(static_dir.rglob("*.js")):
        if any(value in asset.read_bytes() for value in forbidden):
            offenders.append(asset.relative_to(static_dir).as_posix())
    return offenders


def write_release_manifest(
    target: Path,
    version: str,
    source_dir: Path,
    static_dir: Path,
) -> dict:
    payload = {
        "version": version.strip(),
        "source_sha256": tree_fingerprint(
            source_dir,
            {
                ".env",
                ".venv",
                "__pycache__",
                "data",
                "static",
                "test_output.wav",
                "tests",
            },
        ),
        "static_sha256": tree_fingerprint(static_dir),
    }
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload

RUN_MD = """# BookVoice — build artifact (`dist/`)

This folder is the **build output** consumed by the Windows installers.
End users should install via `BookVoice.msi` or `BookVoice-User.msi`, not copy
this folder manually.

## Installers (recommended)

| Installer | Location | Admin required |
|-----------|----------|----------------|
| `BookVoice.msi` | Program Files | Yes (at install) |
| `BookVoice-User.msi` | `%LocalAppData%\\BookVoice\\App` | **No** |

Both use the same self-contained payload. First launch only creates writable
data and log directories under `%LocalAppData%\\BookVoice\\installs\\<id>\\`.

## Developer manual start

```bat
runtime\\worker\\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
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
| `tools/ffmpeg/` | Pinned FFmpeg/FFprobe media tools and license notices |

## Notes

- Writable runtime (sessions, config, logs) lives under
  `%LocalAppData%\\BookVoice\\installs\\<install-id>\\`.
- Set `BOOKVOICE_PORTABLE=1` to keep runtime beside the app (USB/dev).
- English TTS is offline once `data/models/en` is present.
- Voice Studio projects, imported media, profiles, and outputs remain local.
"""


def _exe(name: str) -> str:
    if sys.platform.startswith("win"):
        for candidate in (name + ".cmd", name + ".bat", name + ".exe"):
            if shutil.which(candidate):
                return candidate
    return name


def run(cmd, cwd, check=True, env=None):
    resolved = [_exe(cmd[0]) if i == 0 else c for i, c in enumerate(cmd)]
    print(f"[build] {' '.join(str(c) for c in resolved)}  (cwd={cwd})")
    return subprocess.run(resolved, cwd=str(cwd), check=check, env=env)


def copytree(src: Path, dst: Path):
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def sync_large_tree(src: Path, dst: Path):
    """Synchronize large immutable assets without recopying identical files."""
    dst.mkdir(parents=True, exist_ok=True)
    source_files = set()
    for source in src.rglob("*"):
        if not source.is_file():
            continue
        relative = source.relative_to(src)
        source_files.add(relative)
        target = dst / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        same = False
        if target.is_file():
            source_stat = source.stat()
            target_stat = target.stat()
            same = (
                source_stat.st_size == target_stat.st_size
                and int(source_stat.st_mtime) == int(target_stat.st_mtime)
            )
        if not same:
            shutil.copy2(source, target)
    for target in sorted((p for p in dst.rglob("*") if p.is_file()), reverse=True):
        if target.relative_to(dst) not in source_files:
            target.unlink()
    for directory in sorted((p for p in dst.rglob("*") if p.is_dir()), reverse=True):
        if not any(directory.iterdir()):
            directory.rmdir()


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


def release_frontend_environment(base_environment: dict[str, str] | None = None) -> dict[str, str]:
    """Pin packaged UI requests to the server that delivered the page.

    Local frontend `.env` files are useful for `npm run dev`, but baking a
    fixed localhost hostname into a release breaks when the launcher selects
    127.0.0.1 (and violates the same-origin CSP).
    """
    environment = dict(os.environ if base_environment is None else base_environment)
    environment["VITE_API_BASE_URL"] = "/api"
    environment["VITE_AUDIO_BASE_URL"] = ""
    return environment


def build_frontend():
    if not (FRONTEND / "node_modules").exists():
        run(["npm", "install"], FRONTEND)
    else:
        run(["npm", "ci"], FRONTEND)
    run(["npm", "run", "build"], FRONTEND, env=release_frontend_environment())


def stage_default_voices():
    """Ensure the release payload ships bundled voice reference clips."""
    script = ROOT / "scripts" / "ensure_default_voices.py"
    if not script.is_file():
        raise SystemExit("scripts/ensure_default_voices.py missing")
    import importlib.util as _ilu

    spec = _ilu.spec_from_file_location("ensure_default_voices", script)
    if not spec or not spec.loader:
        raise SystemExit("Could not load ensure_default_voices.py")
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    destination = mod.ensure_default_voices(ROOT)
    print(f"[build] ensured default voice clips → {destination}")


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

    shutil.copy2(BACKEND / "requirements.txt", DIST / "requirements.txt")
    (DIST / "RUN.md").write_text(RUN_MD, encoding="utf-8")
    shutil.copy2(ROOT / "VERSION", DIST / "VERSION")
    write_release_manifest(
        DIST / "release-manifest.json",
        (ROOT / "VERSION").read_text(encoding="utf-8"),
        BACKEND,
        DIST / "static",
    )

    # No .env in the package: the MSI already excludes it, and user settings
    # now live in %LocalAppData%\BookVoice\data\config.json. Keep an example
    # for developers who run uvicorn manually.
    env_example = DIST / ".env.example"
    env_example.write_text('CORS_ORIGINS=[]\nOCR_USE_GPU=false\n', encoding="utf-8")
    env = DIST / ".env"
    if env.exists():
        env.unlink()

    for name in ("BookVoice.bat",):
        src = ROOT / name
        if src.is_file():
            shutil.copy2(src, DIST / name)

    launch_src = ROOT / "launch.py"
    if launch_src.is_file():
        shutil.copy2(launch_src, DIST / "launch.py")

    stage_embed_python()
    stage_runtime_bundle()
    stage_media_tools()

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
    else:
        print("[build] WARNING: voices/ missing after ensure_default_voices()")

    models_src = BACKEND / "data" / "models"
    if models_src.is_dir():
        models_dst = DIST / "data" / "models"
        print(f"[build] Copying bundled model weights from {models_src} → {models_dst}")
        sync_large_tree(models_src, models_dst)
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


def stage_embed_python():
    script = ROOT / "scripts" / "stage_embed_python.py"
    if not script.is_file():
        raise SystemExit("scripts/stage_embed_python.py missing")
    import importlib.util as _ilu

    spec = _ilu.spec_from_file_location("stage_embed_python", script)
    if not spec or not spec.loader:
        raise SystemExit("Could not load stage_embed_python.py")
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.stage_embed_python(ROOT, DIST)


def stage_runtime_bundle():
    """Stage the prebuilt worker that production startup is allowed to use."""
    script = ROOT / "scripts" / "stage_runtime_bundle.py"
    if not script.is_file():
        raise SystemExit("scripts/stage_runtime_bundle.py missing")
    import importlib.util as _ilu

    spec = _ilu.spec_from_file_location("stage_runtime_bundle", script)
    if not spec or not spec.loader:
        raise SystemExit("Could not load stage_runtime_bundle.py")
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    destination = mod.stage_runtime_bundle(ROOT, DIST, version)
    print(f"[build] staged immutable worker runtime → {destination}")


def stage_media_tools():
    """Stage the pinned media executables used by Voice Studio."""
    script = ROOT / "scripts" / "stage_media_tools.py"
    if not script.is_file():
        raise SystemExit("scripts/stage_media_tools.py missing")
    import importlib.util as _ilu

    spec = _ilu.spec_from_file_location("stage_media_tools", script)
    if not spec or not spec.loader:
        raise SystemExit("Could not load scripts/stage_media_tools.py")
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    contract = mod.stage_media_tools(ROOT, DIST)
    print(f"[build] staged FFmpeg/FFprobe {contract['version']} → {DIST / 'tools' / 'ffmpeg'}")


def runtime_contract_errors(dist: Path) -> list[str]:
    """Return release errors when the package could self-provision at startup."""
    manifest_path = dist / "runtime-manifest.json"
    if not manifest_path.is_file():
        return ["runtime manifest missing"]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ["runtime manifest is invalid"]
    if manifest.get("startup_provisioning") != "forbidden":
        return ["runtime manifest forbids no startup provisioning"]
    media_tools = manifest.get("media_tools")
    if not isinstance(media_tools, dict):
        return ["runtime manifest media tools contract missing"]
    if media_tools.get("version") != "8.1.1":
        return ["runtime manifest media tools version is not pinned to 8.1.1"]
    worker = dist / "runtime" / "worker"
    required = [
        worker / "python.exe",
        worker / "python310.dll",
    ]
    errors = [
        f"runtime worker missing: {path.relative_to(dist)}"
        for path in required
        if not path.exists()
    ]
    for key in ("ffmpeg", "ffprobe", "notice", "license"):
        relative = media_tools.get(key)
        if not isinstance(relative, str) or not (dist / relative).is_file():
            errors.append(f"runtime media tool missing: {key}")
    digests = media_tools.get("sha256") or {}
    for key in ("ffmpeg", "ffprobe"):
        relative = media_tools.get(key)
        path = dist / relative if isinstance(relative, str) else None
        if path and path.is_file() and digests.get(key) != file_sha256(path):
            errors.append(f"runtime media tool checksum mismatch: {key}")
    packages = worker / "Lib" / "site-packages"
    for package in (
        "fastapi",
        "uvicorn",
        "chatterbox",
        "torch",
        "torchaudio",
        "transformers",
        "deep_translator",
        "easyocr",
        "PIL",
        "numpy",
        "cv2",
        "soundfile",
        "librosa",
    ):
        if not (packages / package).is_dir() and not (packages / f"{package}.py").is_file():
            errors.append(f"runtime worker missing import: {package}")
    return errors


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
        raise SystemExit(f"Launcher rebuild failed; refusing a stale release: {e}") from e

    built = dist_dir / "Launcher.exe"
    if built.is_file():
        shutil.copy2(built, DIST / "Launcher.exe")
        print(f"[build] Launcher.exe → dist/ ({built.stat().st_size // 1024} KB)")
    else:
        raise SystemExit("Launcher rebuild produced no executable; refusing a stale release.")


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
        "launch.py",
        "VERSION",
        "release-manifest.json",
        "requirements.txt",
        "BookVoice.bat",
        "scripts/kill_stale_bookvoice.ps1",
        "runtime/worker/python.exe",
        "runtime-manifest.json",
        "Launcher.exe",
        "routes/tts.py",
        "routes/voices.py",
        "routes/config.py",
        "routes/studio.py",
        "services/tts_service.py",
        "services/config_service.py",
        "services/media_tools.py",
        "services/path_utils.py",
        "services/studio_service.py",
        "services/voice_profile_service.py",
        "tools/ffmpeg/ffmpeg.exe",
        "tools/ffmpeg/ffprobe.exe",
        "tools/ffmpeg/NOTICE.txt",
        "tools/ffmpeg/LICENSE.txt",
        "static/index.html",
        "data/models/en/tokenizer.json",
        "data/models/en/t3_cfg.safetensors",
        "data/default_voices",
    ]
    for rel in required:
        p = DIST / rel
        if not p.exists():
            errors.append(f"required missing: {rel}")

    default_voice_count = len(list((DIST / "data" / "default_voices").glob("*.wav")))
    if default_voice_count == 0:
        errors.append("data/default_voices must include at least one .wav voice clip")

    errors.extend(runtime_contract_errors(DIST))

    source_pairs = [(BACKEND / "main.py", DIST / "main.py")]
    for source_dir in (BACKEND / "routes", BACKEND / "services"):
        for source in source_dir.glob("*.py"):
            source_pairs.append((source, DIST / source_dir.name / source.name))
    for source, packaged in source_pairs:
        if not packaged.is_file() or source.read_bytes() != packaged.read_bytes():
            errors.append(f"source/package mismatch: {source.relative_to(ROOT)}")

    if (FRONTEND / "dist").is_dir():
        frontend_hash = tree_fingerprint(FRONTEND / "dist")
        dist_hash = tree_fingerprint(DIST / "static")
        backend_hash = tree_fingerprint(BACKEND / "static")
        if frontend_hash != dist_hash or dist_hash != backend_hash:
            errors.append("frontend/dist, dist/static and backend/static are not identical")

    fixed_origins = fixed_loopback_assets(DIST / "static")
    if fixed_origins:
        errors.append(
            "packaged JavaScript contains a fixed loopback origin: "
            + ", ".join(fixed_origins)
        )

    # Parity with the MSI payload: no runtime state in the package
    for forbidden in (".env", "data/voices", "data/sessions"):
        if (DIST / forbidden).exists():
            errors.append(f"stale runtime artifact in dist: {forbidden}")

    # Record a reproducible bundle-size baseline and warn (not fail) over budget.
    measure_bundle = ROOT / "scripts" / "measure_bundle.py"
    if measure_bundle.is_file() and (DIST / "static" / "index.html").is_file():
        import importlib.util as _ilu

        spec = _ilu.spec_from_file_location("measure_bundle", measure_bundle)
        if spec and spec.loader:
            mod = _ilu.module_from_spec(spec)
            spec.loader.exec_module(mod)
            payload = mod.measure(assets_dir=DIST / "static")
            mod.write_baseline(payload, target=ROOT / "tasks" / "bundle-baseline.json")
            initial = payload["initial_entry_kib"]
            budget = payload["budget_kib"]
            print(f"[build] initial bundle entry: {initial:.2f} KiB (budget {budget:.0f} KiB)")
            if initial > budget:
                errors.append(
                    f"initial bundle entry {initial:.2f} KiB exceeds the {budget:.0f} KiB budget"
                )

    # No stale hashed assets left only if index points at them — already checked

    if errors:
        raise SystemExit("Build validation failed:\n  - " + "\n  - ".join(errors))
    print("[build] dist package validation OK")


def build_msi(per_user: bool = False):
    print("[build] Building MSI …")
    cmd = [sys.executable, str(ROOT / "build_msi.py")]
    if per_user:
        cmd.append("--per-user")
    run(cmd, ROOT)


def main():
    parser = argparse.ArgumentParser(description="Build BookVoice release dist/")
    parser.add_argument(
        "--msi", action="store_true", help="Also build installer/BookVoice.msi"
    )
    parser.add_argument(
        "--per-user",
        action="store_true",
        help="With --msi, also build installer/BookVoice-User.msi (no-admin install)",
    )
    parser.add_argument(
        "--skip-frontend", action="store_true", help="Skip npm build (reuse frontend/dist)"
    )
    parser.add_argument(
        "--skip-launcher", action="store_true", help="Skip PyInstaller launcher rebuild"
    )
    args = parser.parse_args()

    print("[build] Building BookVoice portable dist/ …")
    stage_default_voices()
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
    print("[build] Release package ready: dist/")

    if args.msi:
        build_msi(per_user=args.per_user)
        run([sys.executable, str(ROOT / "scripts" / "prepare_release_assets.py"), "--build-bootstrapper"], ROOT)
        print("[build] MSI ready: installer/BookVoice.msi (+ cab*.cab)")
        if args.per_user:
            print("[build] Per-user MSI ready: installer/BookVoice-User.msi")


if __name__ == "__main__":
    main()
