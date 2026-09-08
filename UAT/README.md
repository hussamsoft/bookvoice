# BookVoice UAT — test checklist

Four launchers, four surfaces. Run each, tick the boxes, note failures with
steps to reproduce.

## How these run

They drive the **source checkout**, not a build. `dist/` does not have to exist.

- 1, 2, 3b, 4 run `dev_launcher.py`; 3 runs `serve_bookvoice.py`.
  `launch.py` is the *packaged* launcher — it refuses to start without
  `dist/runtime/worker/python.exe`, so nothing here calls it.
- The app payload is `backend/` (`main.py`, `static/`, `data/models/`).
- The backend runs on `backend\.venv` — CUDA torch and chatterbox live there,
  so narration is real. Override with `BOOKVOICE_DEV_PYTHON`.
- The launcher shell runs on PATH `python`, which needs `pywebview` for the
  native window (1 and 3b). Without it those two fall back to the browser.
- Closing the window (or Ctrl+C) stops the backend. Set
  `BOOKVOICE_DEV_RELOAD=1` for uvicorn `--reload` while editing.

Setup, once:

```bat
python -m venv backend\.venv
backend\.venv\Scripts\pip install -r backend\requirements.txt
pip install pywebview pystray psutil
```

Logs: `%LocalAppData%\BookVoice\installs\<id>\bookvoice_launch.log` and
`bookvoice_server.log`.

## 1 — Desktop app (`1-Desktop-App.bat`)

Native window (pywebview + WebView2). Closest to the shipped product.

- [ ] Window opens, Home shows sidebar, model banner, library
- [ ] Library: book opens, PDF page renders, word text visible
- [ ] Reader toolbar: page nav, bookmark, zoom, auto-turn all respond
- [ ] Play narration: audio starts, words highlight, stop works
- [ ] Scan: camera/file capture, OCR returns editable text
- [ ] Studio: create project, narration form, voices listed
- [ ] Settings: theme toggle, update check, config saves

## 2 — Browser mode (`2-Browser-Mode.bat`)

Same backend in the default browser. Use F12 devtools for console errors.

- [ ] All of §1 passes in-browser
- [ ] No console errors on load, navigation, narration start
- [ ] Refresh mid-narration: page restores sensibly

## 3a — Phone view on this PC (`3b-Phone-View-On-PC.bat`)

Same mobile layout in a 390x844 desktop window — no phone needed.
All of §3 applies, with mouse instead of touch.

## 3b — LAN server / real phone (`3-LAN-Server-Mobile.bat`)

Touch interface on a phone/tablet: open the printed `http://192.168.x.x:PORT`.

- [ ] Phone loads Home; nav rail collapses to icons
- [ ] Library book card fits without horizontal scroll
- [ ] Reader toolbar wraps; page + transcript readable
- [ ] Play narration works over LAN (audio on the phone)
- [ ] No login prompt (expected without a password); set
      `BOOKVOICE_ACCESS_PASSWORD` to test the gate

## 4 — Backend only (`4-Backend-Only.bat`)

API surface. `curl http://127.0.0.1:PORT/api/health` → `{"status":"ready"}`.

- [ ] `/api/books`, `/api/voices/`, `/api/studio/projects` all 200
- [ ] Rebind probe 403s:
      `curl -H "Origin: http://evil.com" -H "Host: evil.com" /api/voices/`
- [ ] TTS flood (17 parallel narrations) → some 429, server stays up

## Review notes (maintainer pass, 2026-09-07)

- Home / Library / Reader / Studio / narration streaming verified working
  against a live backend (desktop-width + 390px mobile viewports).
- CPU-only machine: generation is minutes-per-page; the UI correctly shows
  model-loading + CPU warnings. GPU needed for a real narration timing test.
- Known cosmetic: Library book card can overflow horizontally at 390px.
- Finding: Scan view with no camera shows a blank area with two unlabeled
  "Retry" buttons and no capture affordance. Needs an empty state (what to
  do, file-upload fallback) before this surface is shippable.
- Known pre-existing: `SettingsView.test.jsx` fails lint (`within` import);
  unrelated untracked work, not part of this change set.
