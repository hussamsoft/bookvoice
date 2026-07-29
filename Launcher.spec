# -*- mode: python ; coding: utf-8 -*-
# Builds the BookVoice desktop launcher (Launcher.exe).
# This is a thin launcher: it starts `uvicorn main:app` from the app
# directory (the self-contained dist/ build that contains main.py + static/)
# and opens it in a pywebview window. The backend dependencies live in the
# self-contained worker runtime packaged under dist/runtime/worker.

a = Analysis(
    ['launch.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'psutil',
        'webview',
        'pystray',
        'pystray._win32',
        'PIL',
        'PIL.Image',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='Launcher',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='bookvoice.ico',
)
