# BookVoice UAT — test checklist

Four launchers, four surfaces. Run each, tick the boxes, note failures with
steps to reproduce.

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

## 3 — LAN server / mobile (`3-LAN-Server-Mobile.bat`)

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
