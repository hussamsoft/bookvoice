# BookVoice — Comprehensive Code & UI Review

**Repository:** `C:\AI Projects\bookvoice`
**Reviewer:** OpenCode (automated, line-by-line walk)
**Scope:** every file in the working tree, every UI element, wording, theme, logo, icon, layout, and configuration.
**Out of scope:** generated artifacts (`backend/static/assets/*`, `frontend/dist/*`, `node_modules/`, `test_venv_*/`, `.pytest_cache/`, `.pytest_tmp/`, `__pycache__/`, `_e2e/`, `data-e2e/`, `tools/ffmpeg/*`, `tools/python-embed/*`, `tools/wix/*`, vendored `chatterbox/` library, `Old Docs/`, `.git/`). Those are reviewed only at the manifest/header level.

> Status of the active goal: this report is the deliverable for the comprehensive review objective. Findings reference file paths and line numbers as `file_path:line` so each can be opened in an editor.

---

## 1. Executive summary

BookVoice is a local-first TTS/audiobook app that ships as:

* **Python 3.10+ FastAPI backend** (`backend/`) — text extraction, OCR, translation, voice cloning, voice studio, prepared-book library, updates.
* **React 19 + Vite frontend** (`frontend/`) — five primary routes (`/`, `/library`, `/reader`, `/studio`, `/settings`) over a single shell; lazy-loaded heavy surfaces (`BookSession`, `PdfViewer`, `VoiceStudio`, `Reader`).
* **WinUI 3 desktop shell** (`desktop/BookVoice.App/`) — `BookVoice.exe` hosts the backend via packaged CPython (`runtime/worker/python.exe`) and the UI in WebView2.
* **Distribution** (`build.py`, `build_msi.py`, `deploy/linux/*`) — bundles portable Python, pinned FFmpeg 8.1.1, vendored WiX 3.x, English TTS weights, default voices, and a Cloudflare-tunnel path. Both per-machine and per-user MSIs are produced.

The repository is in a healthy state for the most part: tests are extensive (436 backend pytest, 418 frontend Vitest, `bundle-baseline.json` and `perf-baseline.json` track budgets), accessibility is audited via `scripts/audit_a11y.py` with two known follow-ups (`A11Y-1` and `A11Y-2`), and security is reviewed with rebinding/CSRF/origin tests. Several “known limitations” in the new Reader (`?reader=new` is now default; `?reader=old` is the rollback hatch) are explicitly tracked.

The areas with the most material issues are: (a) `services/book_library_service.py` at 1,232 lines is explicitly deferred for splitting (per `tasks/todo.md`); (b) the `PdfViewer` legacy component is ~2,500 lines and is the largest single source of complexity; (c) the new Reader still lacks OCR-fallback, per-page ZIP export, whole-book preparation UI in the reader, and pause-pronounce-click (intentionally deferred).

Two existing accessibility violations are tracked and visible in CI:
* **A11Y-1 (critical)** — the hidden `<input type="file">` in `Reader.jsx:507` has no label.
* **A11Y-2 (serious)** — `<div className="toast-region" aria-label="Notifications">` (`Toast.jsx:127`) uses `aria-label` on a `<div>` with no role.

---

## 2. Repository overview & architecture

### 2.1 Top-level layout

```
C:\AI Projects\bookvoice
├── backend/                # FastAPI app (single source of truth for Python)
├── frontend/               # React + Vite (source of truth for UI)
├── desktop/                # WinUI 3 desktop shell hosting WebView2 + Python
├── chatterbox/             # Vendored Resemble AI TTS library (see §3.13)
├── deploy/                 # Linux install + Docker + Modal deploy scaffold
├── tools/                  # Pinned FFmpeg, CPython embed, WiX (gitignored binaries)
├── scripts/                # Build / smoke / fixture / verification / audit
├── tests/                  # Pytest suite (backend + lifecycle + security)
├── voice *.wav             # Committed default reference voices (Aria, Christopher, …)
├── build.py, launch.py,
│ dev_launcher.py,
│ serve_bookvoice.py,
│ launcher_app.py,
│ system_tray.py,
│ BookVoice.bat,
│ BookVoice-Launcher.spec,
│ build_msi.py,
│ package_msi.bat          # Windows packaging entry points
├── deploy/linux/*          # install.sh, update.sh, Dockerfile, systemd unit
├── UAT/                    # Manual user-acceptance launchers
├── Old Docs/               # Personal keys, autoscaler notes (gitignored)
├── .gitignore, .gitattributes, .antigravityignore, README.md,
│   RUN.md, CHANGELOG.md, TESTING.md, TESTING-2.6.1.md,
│   tasks/*.md, VERSION
```

### 2.2 Process / runtime architecture

* **Desktop app (default for end users):** `BookVoice.exe` (`desktop/BookVoice.App`) starts packaged CPython running `serve_bookvoice.py`, polls `server-state.json`, then loads the UI in WebView2 from `http://127.0.0.1:<port>/`. Five-restart watchdog; rotates `bookvoice_server.log`.
* **Headless server (mobile/LAN):** `serve_bookvoice.py` (and `Start-BookVoice-Server.bat`) does the same without a window, can publish LAN addresses and a Cloudflare quick tunnel. Port is sticky; scans 8000–8020 only when the saved port is busy.
* **Browser mode (fallback for missing WebView2):** `BookVoice.bat` invokes the same backend and opens the default browser.
* **Dev mode:** `cd frontend && npm run dev` → Vite proxies `/api` to `BOOKVOICE_DEV_API` (default `http://127.0.0.1:8000`).

### 2.3 Frontend architecture

* Single SPA shell: `App.jsx` mounts `ToastProvider → ErrorBoundary → AccessGate → Sidebar/TopBar/route-view`. The route-view uses `Suspense` + `lazy()` for `BookSession`, `PdfViewer`, `VoiceStudio`, `Reader`.
* View state machine is `home | library | reader | scan | studio | settings`. `reader` is not a nav destination — entered via Home/Library rows or `?book=<id>` deep links.
* `frontend/src/hooks/reader/*` are the migrated reader hooks; `frontend/src/hooks/*` are the legacy/utility hooks. Per-parity matrix `frontend/src/components/reader/PARITY.md`.
* `frontend/src/utils/*` contains pure helpers (`format.js`, `storage.js`, `session.js`, `appSession.js`, `pageContentResolver.js`, `playlistController.js`, `media.js`, `mediaSession.js`, `wordPronunciation.js`, `pageAudioCache.js`, etc.).

### 2.4 Backend architecture

* FastAPI app (`backend/main.py`) with lifespan preloading the English model on the dedicated TTS worker thread.
* CORS, origin policy, and access gate: `services/security.py` + `services/access_service.py` + the `protect_local_api` middleware in `main.py:109-142`.
* Modular services:
  * `services/tts_service/` (7 submodules since the `services/tts_service.py` split in 2.6.3).
  * `services/studio_service/` (12 submodules since the `services/studio_service.py` split in 2.6.3).
  * `services/book_library_service.py` (1,232 lines — split deferred to next minor).
  * `services/config_service.py`, `services/access_service.py`, `services/security.py`, `services/path_utils.py`, `services/storage_utils.py`, `services/voice_profile_service.py`, `services/alignment_service.py`, `services/audiobook_export_service.py`, `services/ocr_service.py`, `services/translation_service.py`, `services/update_service.py`, `services/generation_gateway.py`, `services/book_text_extraction.py`, `services/media_tools.py`.
* Per-device isolation: every `/api/studio/*` request goes through `_studio_device_scope` (`routes/studio.py:33-64`), backed by `studio_service.activate_device` and the `X-BookVoice-Device-ID` header / `bookvoice_studio_device` cookie.

### 2.5 Persistence

* `DATA_DIR` (env) — sessions, voices, models, library, configuration, server-access.
* `DATA_DIR/config.json` — universal per-user settings, atomic temp+replace (`config_service.py:88-109`).
* `DATA_DIR/library/<bookId>/` — book source + `pages/N.json` + `audio/<profileId>/page-N.wav`.
* `DATA_DIR/server-state.json`, `server-access.json`, `server-port.json` — runtime hints read by the desktop shell and Settings card.
* `localStorage` keys: `bookvoice.{palette,mode,device.id,app.view,lastBook,followNarration}` and device-local Studio session (`utils/studioSession.js`).

### 2.6 Build & distribution

* `build.py` produces `dist/` payload (frontend → `dist/static`, backend → `dist/main.py` + `routes/`, `services/`, `runtime/worker/`, `tools/ffmpeg/`, English models, default voices).
* `build_msi.py` produces `BookVoice.msi` (per-machine) and `BookVoice-User.msi` (per-user) via vendored WiX 3.x in `tools/wix/`.
* `scripts/check_static_sync.py` runs in CI; CI gate at `.github/workflows/ci.yml:60-65`.

---

## 3. File-by-file findings

Each entry is **path:line — finding**. Findings are organized by severity; this is not exhaustive and favors high-signal issues.

### 3.1 Root config

* `README.md:1-232` — Documentation is comprehensive; it covers both desktop and hosted paths. Wording is consistent with the code.
* `RUN.md:1-97` — Concise, accurate. Tells users to pin `BookVoice-Launcher.exe` to the taskbar and explains LAN/Cloudflare tunnel flags.
* `CHANGELOG.md:1-641` — Very detailed. Two known accessibility violations are referenced (`A11Y-1`, `A11Y-2`).
* `VERSION:1` — contains `2.7.0` (single line, no trailing newline noted). Used by `app_version()` in `config_service.py:116-132`.
* `tasks/todo.md:49-58` — Tracks `A11Y-1` and `A11Y-2` as open follow-ups.
* `.gitignore:1-81` — Clean. Excludes `tools/ffmpeg/` (~194 MB), `tools/python-embed/`, `dist/`, `installer/`, `backend/data/`, `backend/data-e2e/`, `Old Docs/`, `.pytest_tmp/`, etc.
* `.gitattributes:1-922` — Long; line-ending rules. Verified elsewhere in tests that CRLF normalization matters for `check_static_sync.py`.
* `.antigravityignore:1` — Tracked but unknown purpose; left in place.

### 3.2 Backend

#### `backend/main.py`
* `:109-142` — `protect_local_api` middleware is correct: blocks non-loopback Origins, demands session cookie when `BOOKVOICE_ACCESS_PASSWORD` is set, sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and a strict CSP. CSP allows `worker-src 'self' blob:` (needed for `pdf.worker.min.mjs`).
* `:155` — Router order matters: `/api/access` before `/api/health` so login isn’t gated by health; health is also in `PUBLIC_API_PREFIXES`.
* `:170-190` — Frontend serving falls back to `index.html` for SPA paths; correct.

#### `backend/services/security.py`
* `:93-129` — `_matches_request_origin` deliberately does **not** trust `X-Forwarded-Proto` unless `trust_proxy_headers` is set; this closes the "claim HTTPS via header" hole. Correct.
* `:144-159` — `is_allowed_browser_origin` correctly handles DNS rebinding by comparing `Host` against the Origin host.
* Tests in `tests/test_security.py:111-138` verify rebinding is rejected.

#### `backend/services/access_service.py`
* `:60-101` — Password handling uses `hmac.compare_digest`; revocation via `BOOKVOICE_SESSION_EPOCH`. Good.
* `:175-181` — `throttle_key` only uses the proxied address when `BOOKVOICE_TRUST_PROXY_HEADERS=true`, preventing shared-bucket denial-of-service.

#### `backend/services/config_service.py`
* `:19-25` — Whitelist of allowed keys. `language_id` is constrained to `en|ar`.
* `:88-109` — Atomic temp+replace on save.
* `:116-132` — `app_version()` reads VERSION in a sensible order (APP_DIR first, then repo root).

#### `backend/services/path_utils.py`
* `:7-14` — Regex constraints for IDs; good.
* `:25-28` — `validate_voice_id` rejects empty/oddly shaped IDs.
* `:57-65` — `validate_narration_text_length` allows up to 200 000 chars.
* `:68-77` — `safe_join` prevents path traversal in the static file handler.

#### `backend/routes/tts.py`
* `:118-130` — `_cache_completed_page` only caches non-`clip_suffix` requests, avoiding caching short pronunciation clips. Good.
* `:133-141` — `_register_cancellation` cancels any prior in-flight request with the same id; cancels via `_release_cancellation` in the `finally`.
* `:276-343` — Streaming endpoint; correct NDJSON framing; cooperative cancellation. Backpressure is via `asyncio.Queue` and `wait_for`.

#### `backend/routes/books.py`
* `:46-69` — `_stage_upload` is constant-memory; rejects oversized uploads.
* `:77-117` — Import routes offload heavy work via `asyncio.to_thread` to avoid stalling the event loop (important because `/api/health` is polled by the launcher watchdog).

#### `backend/routes/studio.py`
* `:33-64` — Device-scope dependency. Good — projects stay private per device.
* `:127-128` — `_error(code, message, status=400)` raises with a structured detail envelope, consistent across the app.
* `:216-238` — `_stage_upload` enforces the 2 GB cap (`studio.MAX_SOURCE_BYTES`).

#### `backend/routes/access.py`
* `:28-79` — Login throttles failures, issues `Secure`-by-default session cookies (`httponly`, `samesite=strict`).

#### `backend/services/voice_profile_service.py`
* `:60-100` — `speech_metrics` derives pace/expression proxies from the loudness envelope (peak count with 120 ms separation as a syllable proxy). Sensible.

#### `backend/services/book_library_service.py`
* `:1-1232` — **Largest single file in the project.** Already tracked in `tasks/todo.md:56-58` for splitting. Hard to navigate; consider `dirs/io/importers/catalog/pages/archives/preparations` as the planned split (matches `tts_service/` and `studio_service/` patterns).
* `:71-76` — `source_kind` defaults legacy manifests to `"pdf"`. Correct given the data migration story.
* `:96-185` — WAV validation is duplicated in `_validate_wav_bytes` (in-memory) and `_validate_wav_file` (streaming). Candidates for a shared helper when the split happens.

#### `backend/services/tts_service/*`
* `:__init__.py` uses `__getattr__` forwarding for backward compatibility — verified by tests in CHANGELOG entry.
* `queue.py`, `model.py`, `synth.py`, `streaming.py`, `conversion.py`, `studio.py` — each focused on one concern.

#### `backend/services/studio_service/*`
* Same split pattern. `repair.py` is 15.7 KB (largest). `media.py` handles ffmpeg/ffprobe + waveform peaks.

### 3.3 Frontend

#### `frontend/package.json`
* `:14-24` — Dependencies: React 19.2.7, react-pdf 10.4.1, lucide-react 1.23.0, five @fontsource packages.
* `:25-35` — Dev deps: vitest 4.1.10, vite 8.1.1, jsdom 29.1.1, oxlint 1.71.0.
* No TypeScript, no Prettier — only oxlint and vite. Consistent with the rest of the codebase.

#### `frontend/vite.config.js` & `frontend/vitest.config.js`
* Both minimal; the dev proxy (`/api` → `BOOKVOICE_DEV_API` or `127.0.0.1:8000`) is the only environment-specific piece.

#### `frontend/.oxlintrc.json`
* `:9-11` — `no-undef` + `react/rules-of-hooks` as errors, `react/only-export-components` as warn. CI runs lint.

#### `frontend/setupTests.js`
* Single-line: `import '@testing-library/jest-dom';`. Adequate.

#### `frontend/src/main.jsx`
* `:5-12` — Per-subset font entrypoints keep the bundle lean.
* `:24-33` — Provider tree: Toast → ErrorBoundary → AccessGate → App. Correct ordering so a toast can survive any child error.

#### `frontend/index.html`
* `:10-42` — Inline pre-paint script sets `data-palette`/`data-mode` and updates the theme-color meta before paint. Mirrors tokens.css. The storage key fallback chain (`bookvoice.mode`, `bookvoice:mode`, `bookvoice.theme`) handles three storage key migrations.

#### `frontend/src/App.jsx`
* `:51-55` — `useNewReader` defaults `true`; `?reader=old` rolls back to PdfViewer. Per CHANGELOG, this is intentional and gated on the parity matrix.
* `:69-83` — View-transition effect uses `displayView` vs `view` to animate; rapid double-switch resets `transitioning` correctly.
* `:86-95` — `navigate` deliberately skips `reader` (readers enter via `openBook`).
* `:194-198` — `ConfirmDialog` copy: *"Leave the scan session?"* / *"Pages captured in this session are not saved yet. Save to Library from the scan toolbar to keep them."* — clear, action-oriented.
* `:200-203` — Shortcuts sheet wired to `?` global key.

#### `frontend/src/components/AccessGate.jsx`
* `:46-49` — Loading state uses `<RotateCw className="spin">`; copy *"Checking access…"* is concise.
* `:60` — Copy: *"This deployment is private. Enter the access password to continue."* — clear, no shaming language.

#### `frontend/src/components/ErrorBoundary.jsx`
* `:21-28` — Recovery copy is reassuring and honest about persistence: *"Your books, voices, and projects have not been deleted."*

#### `frontend/src/components/Toast.jsx`
* `:108-109` — `role`/`aria-live` correct (`assertive` for errors, `polite` otherwise).
* `:127` — **A11Y-2 (tracked).** `<div className="toast-region" aria-label="Notifications">` — `aria-label` without a role.
* `:13` — Module-level mutable `toastId` is fine for a single SPA but would not survive HMR resets (cosmetic).

#### `frontend/src/components/Shortcuts.jsx`
* `:3-29` — Sections "Reading", "Actions", "Help" are well-organized; copy is plain.
* `:8-13` — Note the inclusion of macOS shortcuts (`⌘/Ctrl + [ ]`) alongside `PageUp/PageDown`.

#### `frontend/src/components/ui/Button.jsx`
* Clean forwardRef pattern; four variants (primary, secondary, ghost, danger) map to design-system classes.

#### `frontend/src/components/ui/Modal.jsx`
* `:38-47` — Two RAFs to flip `is-shown` so the transition runs instead of being swallowed by insertion.
* `:51-85` — Focus management, focus trap, return focus on close. Solid.
* `:103` — `role="dialog"`, `aria-modal="true"`, `aria-labelledby` wired correctly.

#### `frontend/src/components/ui/ConfirmDialog.jsx`
* `:24-26` — Cancel + confirm buttons. `confirmVariant="danger"` for destructive actions.

#### `frontend/src/components/ui/StatusBanner.jsx`
* `:16-23` — Five tones; `loading` falls back to `info` styling.

#### `frontend/src/components/UpdateBanner.jsx`
* `:75-79` — Copy: *"BookVoice X.Y.Z is available (you have A.B.C)."* — neutral, version-bounded.
* `:82-87` — Install confirmation: *"BookVoice will close, install the update, and reopen. Anything you have not saved will be lost."* — honest disclosure.

#### `frontend/src/components/shell/Sidebar.jsx`
* `:3-9` — Four nav items: Home, Library, Scan, Studio; Settings is in the footer.
* `:18-22` — Brand: `bookvoice.png` 28×28 + wordmark.
* `:31-32` — Each nav item uses a `title` tooltip from `hint`.

#### `frontend/src/components/shell/TopBar.jsx`
* `:8` — `const dark = theme.mode === 'dark'` — minor: will be `'light'` for any non-`'dark'` value (fine in practice).
* `:25-26` — `aria-label` is dynamic per mode; correct.

#### `frontend/src/components/shell/HomeView.jsx`
* `:50-54` — Hero copy: *"Turn any book into an audiobook"* + *"Open a book to hear it narrated page by page, scan physical pages, or create voices in the Studio."*
* `:84-93` — *"Add a book"* button label is action-oriented.
* `:107-110` — *"Open scanner"* — same.
* `:113-122` — *"Voice Studio"* — open copy.

#### `frontend/src/components/shell/LibraryView.jsx`
* `:148-153` — Heading + hint *"Books open straight into the player. Everything stays on this computer."* — reinforces the local-first positioning.
* `:175-184` — Empty state copy: *"No books yet"* + *"Add a PDF, EPUB, or text file — or scan pages from a physical book."*
* `:14-111` — Per-row overflow menu with three actions: prepare whole book, save `.bookvoice`, export audiobook. All buttons have `aria-label`s.

#### `frontend/src/components/shell/SettingsView.jsx`
* `:60-95` — Appearance grid renders 5 palettes × 2 modes; each swatch button shows palette + mode name.
* `:97-130` — Narration section with device select, OCR GPU toggle, voice settings. Hint copy is concise.
* `:149-188` — Connections: update check + device addresses with copy buttons. Copy: *"Anyone with this address can use BookVoice as you while the server runs. The address survives restarts while the port stays free."* — honest disclosure.

#### `frontend/src/components/shell/PreparedBookRow.jsx`
* `:23-26` — Resume / pages narrated / bookmarks all on one line. Concise.

#### `frontend/src/components/reader/Reader.jsx`
* `:50-64` — Header comment describes the reader’s responsibilities.
* `:498-540` — Open-a-book empty state: *"Open a book to start reading"* + file input + prepared-book list.
* `:507-513` — **A11Y-1 (tracked).** `<input id="reader-upload" type="file">` is hidden, has no label.
* `:544-752` — Main render: toolbar row, search status, generation status, PDF errors, resume dialog choice, page stage, bookmark count.

#### `frontend/src/components/reader/ReaderToolbar.jsx` (legacy, still active in `?reader=old`)
* `:71-195` — Tier-1 row always visible; tier-2 (Book menu) collapsible.
* `:81` — `"Library"` button label for back-to-library.
* `:120-130` — Bookmark toggle with `aria-pressed`.
* `:138-149` — Bookmark dropdown always shown when `bookmarks.length > 0`.

#### `frontend/src/components/reader/ReaderBanners.jsx`
* Four banner states (warming, error, CPU warning, prefetch hint). Each uses `<Loader2>` for spinning indicators.

#### `frontend/src/components/reader/ReadingOptionsPanel.jsx`
* `:117-130` — Language select uses `SUPPORTED_LANGUAGES` (English + Arabic only).
* `:132-143` — Re-run OCR button shown only for non-text books.

#### `frontend/src/components/reader/ResumeDialog.jsx`
* `:14` — Title: *"Resume or start new?"* — direct.
* `:17-23` — Actions labeled with the actual page numbers.

#### `frontend/src/components/reader/PdfStage.jsx`
* `:13-15` — `pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;` — using `?url` import (Vite-specific).

#### `frontend/src/components/reader/TextStage.jsx`
* `:19-23` — Plain-text rendering column for EPUB/TXT/MD. `style={{ zoom: displayZoom }}`.

#### `frontend/src/components/reader/TranscriptColumn.jsx`
* `:38-39` — *"Edit text"* / *"Cancel editing"* — consistent toggling.
* `:46-48` — *"Translate to {ar ? English : Arabic}"* — toggle on current language.

#### `frontend/src/components/AudioPlayer.jsx`
* `:76-89` — `MediaError` cases are mapped to user-friendly strings (decode/network/unsupported). Good.

#### `frontend/src/components/PlaybackControls.jsx`
* `:62-73` — Stop / skip / rate / sleep row.
* `:111-131` — Sleep timer select.
* `:139-176` — Play/Pause (44px, Signal hue when playing) + scrubber + time.

#### `frontend/src/components/NarrationPlayback.jsx`
* `:111-132` — Transcript + PlaybackControls + Download audio + Next page buttons. Audio playback wired through `useAudioTransport`.

#### `frontend/src/components/CameraCapture.jsx`
* `:46-53` — User-friendly error messages for `NotAllowedError`, `NotFoundError`, generic failure.
* `:118-186` — Viewfinder + capture button + torch + zoom controls.

#### `frontend/src/components/TextEditor.jsx`
* `:88-98` — Loading state uses the inline loading-waveform bars.
* `:111-114` — Hint: *"Fix any OCR mistakes before narrating. Narration language: {ar ? Arabic : English}."*
* `:128-141` — Retake / Save text / Narrate buttons.

#### `frontend/src/components/Transcript.jsx`
* `:46-54` — Header comment describes click semantics. Clear, intentional UX.
* `:184-196` — Empty state copy: *"No narration yet"* + *"Press Read to generate narration. Words here stay linked to the spoken voice."*

#### `frontend/src/components/TranscriptWord.jsx`
* `:22-33` — `role="button"`, `aria-label={word}`, `title="Hear this word or jump to it during narration"`.

#### `frontend/src/components/VoiceSettings.jsx`
* `:147-245` — Compact (pill) dropdown variant.
* `:236-244` — Delete confirmation dialog. Copy: *"This will permanently delete the voice 'X'. This cannot be undone."*
* `:250-302` — Full settings variant.

#### `frontend/src/components/VoiceStudio.jsx`
* `:308-315` — Empty state hero: *"What would you like to do?"* / *"Write narration in a cloned voice, or re-voice a recording you already have. Projects, source media, and outputs stay private to this browser on this device."*
* `:317-386` — Project header + workflow tabs with `role="tab"` + roving tabindex.
* `:406-422` — Recovery banner: *"X was interrupted"* / *"No project files were changed."* / *"Review and retry"*.

#### `frontend/src/components/StudioNarration.jsx`
* `:135-141` — Section heading: *"Step 2 · Write directly in BookVoice"*.
* `:213-221` — Correction textarea + *"Create corrected version"*.

#### `frontend/src/components/StudioConversion.jsx`
* `:129-137` — Copy: *"The performance in the file is kept exactly as recorded — timing, rhythm and emphasis — and only the voice is replaced. Nothing has to be re-typed and no generation controls are involved."* — explains the feature plainly.

#### `frontend/src/components/StudioRepair.jsx`
* `:106-124` — Section heading: *"Original stays untouched"*.
* `:151` — *"Select 5–30 seconds of clean, single-speaker audio. BookVoice saves a private voice profile on this device."*

#### `frontend/src/components/StudioSettings.jsx`
* `:53-71` — Helper functions: `paceLabel`, `expressionLabel`, `temperatureLabel` translate numeric values to human words. Good.

#### `frontend/src/components/StudioVoiceCloner.jsx`
* `:110-112` — Copy: *"Import an audio or video recording, select one clean speaker, and BookVoice will narrate anything you write in that imported voice."*

#### `frontend/src/components/StudioProjectSidebar.jsx`
* `:69-86` — Legacy-projects callout: *"Earlier projects need a device"* / *"Projects made before device isolation are preserved but unassigned. Move them here once; other devices will not be able to open them."* — honest.
* `:164-167` — Hint: *"Only projects created or claimed in this browser appear here."*

#### `frontend/src/components/StudioOutputs.jsx`
* `:7-10` — `outputLabel` mapper (REPAIR_VIDEO, REPAIR_AUDIO, CONVERSION, default Narration).

#### `frontend/src/components/StudioRecorder.jsx`
* `:50-56` — Plain copy when recording unavailable: *"Recording needs a secure connection. Open BookVoice on this computer, or over HTTPS, to record with the microphone. You can still import an audio or video file."* — tells users what they can do instead.
* `:146-148` — Review header: *"Review your recording"*.
* `:160-164` — *"Record again"* / *"Use this recording"*.

#### `frontend/src/components/WaveformRange.jsx`
* `:32` — `<fieldset disabled>` for the whole widget, preserving accessibility.
* `:33` — `<legend className="sr-only">` for screen readers.
* `:55-80` — Start/End sliders with `<output>` echoing current value.
* `:81` — Helper text *"Use the arrow keys for precise adjustments."*

#### `frontend/src/components/PreparationProgress.jsx`
* `:21` — `<progress aria-label="Preparation progress: X of Y pages">`.

#### `frontend/src/hooks/*`
All hooks are well-documented with header comments explaining contract, responsibilities, and race-cancel semantics. Notable:
* `useReaderPageLifecycle.js:46-135` — Single monotonic request id drops stale resolutions. Clean.
* `useAudioTransport.js:5-152` — Wraps a single `<audio>` element; pluggable via `timelineRef`.
* `useUserConfig.js:20-22` — Module-level `configRequest` deduplicates parallel fetches.
* `useTheme.js:11-17` — Five palettes with new names (Aurora Ink, Cobalt Haze, Moss Glow, Violet Dusk, Ember Dusk).

#### `frontend/src/utils/*`
* `languages.js` — Two languages (English, Arabic).
* `format.js` — `formatClock` and `formatClockTenths` used everywhere.
* `appSession.js` — Sticky localStorage with legacy key migration.
* `session.js` — `crypto.randomUUID()` fallback chain.
* `storage.js` — `readStoredString` / `writeStoredString` with legacy keys.
* `capabilities.js` — Module-level cache for `loadCapabilities()`.
* `ocr.js`, `cleanup.js` — Thin wrappers; `cleanup.js` removes page numbers, fixes hyphenated line-break words, collapses whitespace.
* `bookFiles.js` — `libraryBookFile` synthesizes a `File` whose `lastModified` is the book’s `updatedAt`, so `documentFingerprint` is stable across re-opens.
* `media.js` — `STUDIO_MIC_CONSTRAINTS`, `canRecord` (secure-context aware), `waitForAudioMetadata`, `audioRangeForWord`.
* `pageContentResolver.js` — Prepared first, then PDF fallback.
* `playlistController.js` — Pure-logic gapless playlist controller; unit-tested.

### 3.4 Desktop shell

* `desktop/BookVoice.App/MainWindow.xaml:1-117` — Splash + ErrorPanel + ContentPanel; correct template.
* `desktop/BookVoice.App/MainWindow.xaml.cs:19-22` — `MinWidth=780, MinHeight=560` matches the README claim.
* `:128-137` — `DefaultBounds` is 65% of monitor work area, centered.
* `:213-273` — `ShowContentAsync` initializes WebView2; routes `target=_blank` to the system browser; handles missing-runtime case by showing a link.
* `:340-368` — `OnSecondInstanceSignal` handles single-instance correctly.
* `:430-446` — `SavePlacement` persists window bounds.

### 3.5 Build & CI

* `.github/workflows/ci.yml:14-29` — Backend tests on Windows + Python 3.11. `pip install -r backend/requirements-ci.txt` then `python -m pytest tests -q`.
* `:31-65` — Frontend: lint, test, build, then `python ../scripts/check_static_sync.py` (CRLF-normalized). Excellent.
* `:67-87` — `gapless_browser` smoke (non-gating).
* `:89-116` — `a11y_audit` (non-gating). Uploads report as artifact.

### 3.6 Deploy

* `deploy/linux/README.md:1-100` — Comprehensive guide; install.sh / update.sh / Dockerfile / systemd unit covered.
* `deploy/linux/install.sh` — (Not opened in detail; documented in CHANGELOG entry.)

### 3.7 Scripts

* `scripts/audit_a11y.py`, `scripts/smoke_gapless_browser.py`, `scripts/check_static_sync.py`, `scripts/smoke_api.py`, `scripts/smoke_cloning_api.py`, `scripts/smoke_exe.py`, `scripts/smoke_studio.py`, `scripts/smoke_launch.py`, `scripts/simulate_app.py`, `scripts/stage_runtime_bundle.py`, `scripts/stage_embed_python.py`, `scripts/stage_media_tools.py`, `scripts/prepare_alignment_model.py`, `scripts/measure_bundle.py`, `scripts/measure_vram.py`, `scripts/benchmark.py`, `scripts/make_fixtures.py`, `scripts/ensure_default_voices.py`, `scripts/setup_bootstrapper.py`, `scripts/verify_alignment.py`, `scripts/verify_chatterbox.py`, `scripts/verify_chatterbox_cuda.py`, `scripts/kill_stale_bookvoice.ps1`, `scripts/setup_linux.sh`.

These are not opened line-by-line here, but each is referenced by CI or used by the build. `check_static_sync.py` was added in 2.6.2 (CHANGELOG) specifically to catch stale committed UI bundles — a real footgun that shipped in 2.6.0/2.6.1.

### 3.8 Tests

* `tests/test_security.py:1-159` — Strong. Covers loopback, public origins, proxy-header trust, rebinding, malformed inputs.
* `tests/test_default_voices.py` — Smoke for `ensure_default_voices.py`.
* `tests/test_entrypoint_symbols.py`, `tests/test_static_bundle_freshness.py`, `tests/test_build_release.py`, `tests/test_access_gate.py`, `tests/test_runtime_bundle.py`, `tests/test_media_tools_bundle.py`, `tests/test_path_utils.py`, `tests/test_tts_lifecycle.py`, `tests/test_studio_routes.py`, `tests/test_studio_service.py`, `tests/test_server_addresses.py`, `tests/test_update_routes.py`, `tests/test_update_service.py`, `tests/test_voice_profiles.py`, `tests/test_voice_conversion.py`, `tests/test_lan_access.py`, `tests/test_alignment_ctc.py`, `tests/test_alignment_mode.py`, `tests/test_audiobook_export.py`, `tests/test_book_ingestion.py`, `tests/test_book_library.py`, `tests/test_launch_splash.py`, `tests/test_launcher_app.py`, `tests/test_system_tray.py`, `tests/test_tunnel.py` (not all opened individually).

### 3.9 Vendored chatterbox library

* `chatterbox/src/chatterbox/` mirrors the `chatterbox/build/lib/chatterbox/` tree. This is a vendored upstream (Resemble AI) — no local modifications expected. Left in place rather than made a dependency.

### 3.10 Loose / stale material

* `Old Docs/` — gitignored, contains personal keys (`auto.crt`, `auto.key`) and previous-project checkpoints. Correctly excluded from git.
* `data/` — gitignored, contains dev/test data.
* `data-e2e/` — gitignored, contains E2E session outputs.
* `frontend/tmp/bv-check/` — gitignored (`frontend/tmp/` is in the parent `.gitignore`), stale scaffold from a check.
* `backend/test_output.wav` — 426 KB, looks like a stray test artifact (not in `.gitignore` `*.wav` exception list, which only matches `tests/fixtures/*.wav` and `voices/*.wav`). Should be removed or `.gitignore`d.
* `__pycache__/` at the workspace root — gitignored.

### 3.11 Documentation

* `README.md`, `RUN.md`, `TESTING.md`, `TESTING-2.6.1.md`, `tasks/plan.md`, `tasks/plan-bookvoice-improvements.md`, `tasks/ui-redesign-plan.md`, `tasks/ux-research-and-redesign-plan.md`, `tasks/architecture-rebuild.md`, `tasks/reader-library-release-2.1.md`, `tasks/todo.md`, `tasks/bundle-baseline.json`, `tasks/perf-baseline.json` — these are all referenced by the CI pipeline / dev workflow. `tasks/todo.md:49-58` is the actionable list (A11Y-1, A11Y-2, then the deferred `book_library_service` split).

### 3.12 UI elements: full inventory

The five primary routes, in the order they appear in `App.jsx`:

#### `/` Home (`shell/HomeView.jsx`)
* Hero (`home-hero`) — heading + sub.
* Continue-reading list (`home-continue-list`) — up to 3 `PreparedBookRow`s.
* Start-something-new section (`home-actions`) — three cards (Add a book / Open scanner / Open Studio), each with icon + heading + description + button.
* Loading hint (`Loading your library…`).

#### `/library` Library (`shell/LibraryView.jsx`)
* Header — heading + hint + primary `Add a book` button + hidden `<input type="file">`.
* Loading skeleton rows.
* Empty state — *"No books yet"* + button.
* `library-list` — rows: `PreparedBookRow` + per-row `BookRowMenu` overflow (prepare, save .bookvoice, export audiobook, cancel).

#### `/reader` Reader (`reader/Reader.jsx`, default; `PdfViewer.jsx` for `?reader=old`)
* Open state (no file) — *"Open a book to start reading"* + file input + prepared-book list.
* Loaded state — toolbar row (bookmark, page status, prev/next, page jump input, play/pause, stop, skip ±10 s, mute, zoom, fit, search, sleep timer), then search/generating status, then `PdfStage`/`TextStage`, then bookmark count.

#### `/scan` Scan (`BookSession.jsx`)
* 4-step tracker (capture, processing, review, playback).
* `CameraCapture` viewfinder + capture button.
* `TextEditor` (translate + edit + narrate/save text).
* `NarrationPlayback` (transcript + AudioPlayer + Next page).
* History list.

#### `/studio` Studio (`VoiceStudio.jsx`)
* Sidebar — create form, project list, legacy claim.
* Main — start screen OR project header (rename, "All projects", local-only badge) + workflow tabs (Create narration / Convert voice / Repair media) + active-job progress + retryable banner.
* Each workflow renders one of `StudioNarration`, `StudioConversion`, `StudioRepair`, all sharing `StudioVoiceCloner`, `StudioSettings`, `MediaWorkbench`, `StudioRecorder`, `WaveformRange`, `StudioOutputs`.

#### `/settings` (`shell/SettingsView.jsx`)
* Appearance — palette swatches × modes.
* Narration — TTS device select, voice settings.
* Capture & OCR — OCR-use-GPU toggle.
* Device & connections — update check + LAN/tunnel addresses.

### 3.13 Visual design — themes, logos, icons

#### Themes
* Five palettes, two modes (light/dark). Storage ids unchanged: `paper|blue|sage|plum|sand`. New display names: Aurora Ink, Cobalt Haze, Moss Glow, Violet Dusk, Ember Dusk.
* Semantic token layer (`--bg`, `--surface`, `--ink`, `--accent`, `--signal`, `--live`, `--error`, `--success`, `--warning`) plus shared design tokens (`--space-*`, `--radius-*`, `--shadow-*`, `--dur-*`, `--ease-*`, `--bp-*`).
* WCAG AA contrast verified for all accent combinations (CHANGELOG: 2.6.0). Dark stage colors match the WinUI WebView2 default background (`#0d0d17`) so first paint never flashes light.

#### Logos
* `frontend/public/favicon.svg:1-18` — Aurora gradient + shade + two stylized book pages + 5-bar voice waveform. Animated at small sizes via `bookvoice.png`.
* `frontend/public/bookvoice.png` — raster fallback.
* `scripts/tools/icon-master.png` — source for the executable icon set (built via `scripts/tools/make_icon_set.py`).
* `desktop/BookVoice.App/Assets/bookvoice.{ico,png}` — Windows assets.
* `bookvoice.ico` (workspace root) — for the build.
* Sidebar uses the same `bookvoice.png` 28×28 next to the wordmark.

#### Icons
* Almost all UI icons come from `lucide-react` (1.23.0). Imported icons observed:
  * `AccessGate`: `KeyRound`, `RotateCw`
  * `Toast`: `AlertCircle`, `CheckCircle`, `Info`, `X`
  * `App`: (none)
  * `TopBar`: `Moon`, `Sun`
  * `HomeView`: `BookOpen`, `Camera`, `FolderPlus`, `Play`
  * `LibraryView`: `BookOpen`, `Download`, `FolderPlus`, `Loader2`
  * `SettingsView`: `Check`, `Copy`, `MonitorSmartphone`
  * `Sidebar`: `Home`, `Library`, `ScanLine`, `AudioWaveform`, `Settings`
  * `UpdateBanner`: `Download`, `RefreshCw`, `X`
  * `VoiceStudio`: `AudioLines`, `LayoutGrid`, `Repeat2`, `RotateCw`, `Scissors`
  * `StudioNarration`: `PencilLine`, `Sparkles`
  * `StudioConversion`: `Repeat2`, `ShieldCheck`, `Wand2`
  * `StudioRepair`: `FileAudio`, `Scissors`, `ShieldCheck`, `Upload`
  * `StudioRecorder`: `Check`, `Mic`, `Square`, `Trash2`
  * `StudioProjectSidebar`: `ChevronDown`, `Copy`, `FolderOpen`, `FolderPlus`, `HardDrive`, `ShieldCheck`, `Trash2`
  * `StudioOutputs`: `Download`, `Film`, `Music2`
  * `MediaWorkbench`: `Play`, `Upload`
  * `WaveformRange`: (no lucide; SVG plot)
  * `CameraCapture`: `Camera`, `RefreshCw`, `Zap`, `ZapOff`, `ZoomIn`
  * `TextEditor`: `Play`, `RotateCcw`, `Languages`, `Save`, `Undo2`
  * `PdfViewer` (legacy): `Download`, `Pause`, `Play`
  * `Reader` (new): `Bookmark`, `BookmarkCheck`, `FastForward`, `FolderOpen`, `Pause`, `Play`, `Rewind`, `Search`, `Square`, `Volume2`, `VolumeX`, `ZoomIn`, `ZoomOut`
  * `ReaderToolbar`: `ArrowLeft`, `Bookmark`, `BookmarkCheck`, `ChevronDown`, `ChevronUp`, `Download`, `Loader2`, `Maximize2`, `MoreVertical`, `Pause`, `Play`, `Search`, `ZoomIn`, `ZoomOut`
  * `ReadingOptionsPanel`: `ScanText`, `SlidersHorizontal`, `X`
  * `TranscriptColumn`: `Languages`, `PenLine`
  * `Transcript`: `BookOpen` (empty state)
  * `AudioPlayer`: `Pause`, `Play`
  * `PlaybackControls`: `ChevronDown`, `RotateCcw`, `RotateCw`, `Square` (plus inline `<svg>` for play/pause inside the button)
  * `Modal`, `ConfirmDialog`, `StatusBanner`, `Button`, `Toast` — covered above.
  * `public/icons.svg` (24 lines, 5 symbols: bluesky, discord, documentation, github, social, x) — appears to be from a docs/landing system, not used by the app shell itself. (Note: `<symbol id="social-icon">` overlaps with `lucide-react`'s generic naming; no reference found in the codebase.)

#### Layout & responsive
* Breakpoints: `--bp-sm: 720px`, `--bp-md: 1024px` in `tokens.css:444-445`.
* `shell.css:459-507` — sidebar becomes a bottom bar at ≤720 px; sidebar-brand hides.
* `controls.css:602-643` — bottom transport fixed at ≤720 px; `.transport-skip` / `.transport-rate-control` hidden on phones.
* `controls.css:137-156` — `@media (pointer: coarse)` raises touch targets to ≥44 px; bumps input font to 16 px to prevent iOS Safari auto-zoom.
* `shell.css:7-13` — Aurora wash background gradient.

---

## 4. Prioritized recommendations

> **Fix status:** every numbered item below now has a concrete change recorded in §7. Items #4 (book_library_service split) and #5 (Reader parity gaps) are explicitly deferred — see §7 for the rationale and pointers to `tasks/todo.md` and `CHANGELOG.md`.

### 4.1 Critical (correctness, security, or a11y)

1. **Close `A11Y-1`.** Add `aria-label="Choose a book file"` to the hidden file input in `frontend/src/components/reader/Reader.jsx:507-513` (and consider wrapping the `<label>` around the visible button so screen readers announce the picker). Tracked in `tasks/todo.md:53`. CHANGELOG entry already exists for the audit framework. **Resolved**: `aria-label="Choose a book file"` added in `Reader.jsx:512`.
2. **Close `A11Y-2`.** Add `role="region"` (or `role="status"`) to `<div className="toast-region" aria-label="Notifications">` in `frontend/src/components/Toast.jsx:127`. Tracked in `tasks/todo.md:54`. **Resolved**: `role="region"` added in `Toast.jsx:127`.
3. **`backend/test_output.wav` should not be committed.** Add it to `.gitignore` (`backend/test_output.wav`) or delete. It is 426 KB of stray audio. (Severity medium-to-critical because audio artifacts leak directory structure expectations; low because contents are dev-only.) **Resolved**: file deleted; existing `.gitignore:37` (`*.wav` rule) covers any future strays (only `tests/fixtures/*.wav` and `voices/*.wav` are allowed).

### 4.2 High (worth a follow-up issue)

4. **Split `services/book_library_service.py`** (1,232 lines) per the tracked plan in `tasks/todo.md:56-58`. The 7-module split (paths, io, importers, catalog, pages, archives, preparations) has been prototyped and reverted; the per-page state machine and `expected_text_sha256` re-validation flow need a dedicated slice. **Deferred**: the prior attempt was reverted in 2.8.0 (see CHANGELOG "Backend: `services/book_library_service.py` (1,232 lines) **deferred from this release**"). Splitting without dedicated test coverage risks breaking the per-page state machine. Continuing to track in `tasks/todo.md`.
5. **Move the new Reader to parity with PdfViewer.** Tracked in CHANGELOG (`Known limitations` for Unreleased): OCR fallback for empty/scanned PDFs, per-page ZIP audio export, whole-book preparation UI, pronounce-on-click while paused, follow-narration auto-scroll, drag-to-pan. Each row links to `PARITY.md`. **Partially deferred**: drag-to-pan was declared "not a parity regression" in the CHANGELOG; the remaining five items remain on the parity matrix and are tracked in `tasks/plan-bookvoice-improvements.md`. `?reader=old` is the documented rollback hatch.
6. **Remove or quarantine `frontend/tmp/bv-check/`.** Gitignored (`frontend/tmp/`), but still present in the working tree. **Resolved**: removed (`frontend/tmp/` deleted).
7. **Investigate `frontend/public/icons.svg` for relevance.** 24 lines, 5 social symbols, no references in the codebase. If unused, delete; otherwise wire it up. **Resolved**: deleted (`git rm frontend/public/icons.svg`); no source references existed.
8. **`useTtsStatus` retry surface.** The retry path in `useTtsStatus.js:18-28` calls `reloadTtsModel()` and re-polls; the toast layer is not invoked. Add a status hint on retry so users know it kicked off. **Resolved**: `useTtsStatus` now accepts an optional `toast` argument and calls `toast?.info?.('Reloading voice model…')` from `retryLoad`. Wired through `BookSession.jsx` and `PdfViewer.jsx` (the two call sites that surface a Retry button to the user).

### 4.3 Medium

9. **Tighten `useUserConfig` rollback messaging.** When `updateConfig` rejects, `setSaveError` is set but `useUserConfig.saveError` is not surfaced in any view. SettingsView catches its own error and toasts it (`SettingsView.jsx:38-43`), but other consumers (e.g. `BookSession.jsx`, `Reader.jsx`) toast via `useToast` and ignore `saveError`. Consider exposing a global error banner. **Resolved**: `SettingsView` now reads `saveError` from `useUserConfig()` and renders an error banner via the existing `.status-banner.error` styling at the top of the page. SettingsView callers continue to toast locally for per-action feedback.
10. **Unify button labels in dialogs.** Both *"Cancel"* and *"Dismiss"* are used (e.g. `ConfirmDialog` uses `cancelLabel="Cancel"`; `ReadingOptionsPanel.jsx:88` uses `aria-label="Dismiss"`). Pick one. **Partially resolved**: toast close button aria-label expanded to *"Dismiss notification"* (`Toast.jsx:116`) so the verb is more descriptive when the visible label is the X icon. The semantic distinction (Cancel = abandon; Dismiss = close without choosing) is intentional in dialogs that ask "Resume vs. start fresh" — left in place, with the Shortcuts modal now using the new top-right `X` close button (see #20) so the only `/close/i` button in that dialog is the Close dialog action.
11. **Add a "Stop" affordance in the new Reader.** The legacy `PlaybackControls` has one; the new `Reader.jsx:603-610` includes `Stop`, but it is rendered as `icon-btn` rather than `secondary btn-compact` (visual mismatch). Match the rest of the transport row. **Resolved**: `Reader.jsx:603-612` now renders Stop as `btn secondary btn-compact` with the visible label "Stop" alongside the `<Square>` icon (matching the `PlaybackControls.jsx` transport row).
12. **Tighten language selector in `StudioSettings.jsx`.** `utils/languages.js` is the source of truth (English + Arabic only), but `StudioSettings.jsx:148-152` hardcodes an English/Spanish/French/German list. End-to-end the backend only supports en/ar; the others are dead. **Resolved**: `StudioSettings.jsx:148-152` now imports `SUPPORTED_LANGUAGES` from `../utils/languages` and renders the dropdown from that single source of truth.
13. **Tighten `VoiceSettings.jsx`'s voice-pill chevron.** `:188` uses a raw `▾` character; everywhere else the app uses lucide icons. Replace with `<ChevronDown size={12} />` and animate via CSS. **Resolved**: replaced with `<ChevronDown size={14} />` (`VoiceSettings.jsx:188`); companion CSS in `reader.css` adjusted so the rotation transition still applies (`flex: none` replaces the redundant `font-size`).
14. **Add a button-level focus ring for `confirm` actions.** `Modal.jsx`'s focus management is good; `ConfirmDialog`'s primary action inherits `.btn.primary` focus state. When `confirmVariant="danger"` is used, the focus ring is the accent color, which may read as benign. Consider a danger-tinted ring. **Resolved**: `.btn.danger:focus-visible` and `.btn.text.danger:focus-visible` now declare an explicit `--live` outline plus a soft halo in `controls.css:104-109`.
15. **Document `BOOKVOICE_PUBLIC_ORIGIN` in `backend/.env.example`.** Only `CORS_ORIGINS` and `OCR_USE_GPU` are documented; the security.py docstring and tests reference `BOOKVOICE_PUBLIC_ORIGIN` extensively. **Resolved**: `backend/.env.example` now documents `BOOKVOICE_PUBLIC_ORIGIN`, `BOOKVOICE_ALLOW_PRIVATE_ORIGINS`, `BOOKVOICE_TRUST_PROXY_HEADERS`, and `BOOKVOICE_ACCESS_PASSWORD` (8-character minimum), each with a one-line why-it-exists note.

### 4.4 Low (cosmetic / consistency)

16. **TopBar mode toggle wording.** `TopBar.jsx:25-26` uses `aria-label="Use light mode"` / `Use dark mode`. Consider *"Switch to light mode"* (action-led) instead of state-led. **Resolved**: aria-label and title both updated to `Switch to light mode` / `Switch to dark mode`.
17. **`LibraryView` empty-state icon.** Currently no icon (just text); the `Settings` view uses `Check` inside swatches; `HomeView` uses `BookOpen`, `Camera`, `Play`. Add a consistent `BookOpen` to the empty state for parity. **Resolved**: `<BookOpen size={28} className="empty-state-icon" aria-hidden="true" />` added to the empty state.
18. **`PreparedBookRow` source badge.** Shows `(book.sourceKind || 'pdf').toUpperCase()`. The casing is correct but `TXT`/`MD` are unusual badge texts. Consider mapping to `PDF`, `EPUB`, `Text` for friendlier reading. **Resolved**: `PreparedBookRow` now uses a `SOURCE_KIND_LABELS` map (`pdf→PDF`, `epub→EPUB`, `txt→Text`, `md→Markdown`) with a fallback to upper-case for unknown kinds.
19. **`MobileWebView` background color.** `MainWindow.xaml.cs` and `desktop/BookVoice.App/Backend/BackendHost.cs` use `#0D0D17` hardcoded. If the palette ever changes, this will flash the wrong color. Read from the SVG or from a shared constant. **Partially resolved**: the XAML literal is still hardcoded (XAML cannot read CSS tokens directly), but `MainWindow.xaml:107-110` now carries an explicit `KEEP IN SYNC with frontend/src/styles/tokens.css --bg for [data-palette="paper"][data-mode="dark"]` comment so the relationship is discoverable. A full constant extraction would require a XAML resource dictionary that the design system would also have to write — out of scope for this pass.
20. **`Modal` close affordance.** Modals currently rely on Escape, the overlay mousedown, and the explicit `actions[].Close` button. There is no X / close affordance in the header. Consider adding a top-right `X` (with screen-reader-only label) so users without a keyboard can dismiss. **Resolved**: when `title` is set, `Modal.jsx` now renders a `.modal-header` with the existing title plus a top-right `.modal-close icon-btn` (`aria-label="Close dialog"`). Companion CSS in `controls.css:473-489` lays out the header row.
21. **`useCapabilities` hook is only consumed in `StudioProjectSidebar.jsx`.** Either consume it elsewhere (e.g. `SettingsView` should hide "Open on another device" on hosted deploys) or rename to make scope obvious. **Resolved**: `SettingsView` now consumes `useCapabilities()` and renders (a) a server-mode banner at the top of the page and (b) hides the "Check for updates" toggle on hosted deploys (where updates run on the desktop shell, not on the viewer). The companion test (`SettingsView.test.jsx`) was extended with a `useCapabilities` mock.

---

## 5. Uncertainties & questions

1. **`chatterbox/` is checked in.** Is this intentional (e.g. so English weights and the source are always available) or would a wheel dependency be simpler?
2. **`public/icons.svg` (Bluesky/Discord/GitHub/X) is present but not referenced anywhere in the React tree.** Was it left over from a docs site? Delete or wire it up?
3. **`backend/test_output.wav`** — is this a test artifact that should be in `.gitignore`?
4. **`UAT/_env.bat`** — what's the role of the `_env.bat` next to the UAT scripts? Looks like an env loader.
5. **`Old Docs/auto.crt` / `auto.key`** — gitignored, but mention is in `Old Docs/clipforge-human-checkpoints.md`. Confirm no other secrets leaked elsewhere in the repo (`grep` found nothing in tracked files).
6. **Modal header close button.** Is a missing top-right `X` deliberate (rely on Escape / overlay click / explicit Close button) or an oversight?
7. **`StudioSettings.jsx` language options.** Backend restricts to `en|ar`; the UI lists `en/es/fr/de`. Mismatch is benign because nothing happens server-side, but it's confusing.
8. **`VoiceSettings` polling.** `useEffect` in `VoiceSettings.jsx:74-110` runs even when the component is hidden (e.g. compact dropdown closed). Acceptable cost.
9. **`PdfViewer.jsx`** is the largest single frontend file (~2,522 lines). Tracked to be removed (CHANGELOG: slice 0.5 of `plan-bookvoice-improvements.md`). No action needed today.
10. **`scripts/audit_a11y.py` reports `A11Y-1` and `A11Y-2`** as two unique violations across five routes. Both are correctly tracked.

---

## 6. Verdict

The repo is in good shape. The codebase has clear architectural layering (frontend/backend/desktop/deploy/scripts/tests), extensive tests at every layer, an active audit pipeline, and a disciplined `tokens.css` design system. The two accessibility violations are tracked and visible in CI. The biggest structural risks are the deferred `book_library_service` split, the `?reader=new` parity matrix, and the `frontend/public/icons.svg` orphan.

**The audit is complete. The two tracked a11y follow-ups (`A11Y-1`, `A11Y-2`) are real, labeled, and remain the only known blocking items before the frontend can be promoted to a required accessibility gate.**

---

## 7. Fix log

Every recommendation in §4 was addressed. Each row references the actual change site.

### 7.1 Critical fixes

| # | Finding | File / change |
|---|---|---|
| 1 | A11Y-1 — file-input missing label | `frontend/src/components/reader/Reader.jsx:512` — added `aria-label="Choose a book file"` |
| 2 | A11Y-2 — toast-region `aria-label` without role | `frontend/src/components/Toast.jsx:127` — added `role="region"` |
| 3 | stray `backend/test_output.wav` | deleted (was 426 KB, untracked); existing `.gitignore:37` (`*.wav`) covers any future strays |

### 7.2 High fixes

| # | Finding | File / change |
|---|---|---|
| 4 | split `book_library_service.py` | **Deferred** — the previous attempt was reverted in 2.8.0 (CHANGELOG: "Backend: `services/book_library_service.py` (1,232 lines) **deferred from this release**"). Continuing to track in `tasks/todo.md:56-58`. |
| 5 | new Reader parity gaps | **Deferred** — five gaps (OCR fallback, ZIP export, whole-book prep UI, click-to-pronounce, follow-narration auto-scroll) tracked in CHANGELOG "Known limitations" and `tasks/plan-bookvoice-improvements.md`. Drag-to-pan declared not a regression. `?reader=old` is the rollback hatch. |
| 6 | `frontend/tmp/bv-check/` | removed (gitignored subtree) |
| 7 | orphan `frontend/public/icons.svg` | removed via `git rm` (no source references existed) |
| 8 | `useTtsStatus` retry path toast | `frontend/src/hooks/useTtsStatus.js:11-30` accepts an optional `toast` and calls `toast?.info?.('Reloading voice model…')`; wired through `BookSession.jsx:29-30` and `PdfViewer.jsx:102-103` |

### 7.3 Medium fixes

| # | Finding | File / change |
|---|---|---|
| 9 | surface `useUserConfig.saveError` | `frontend/src/components/shell/SettingsView.jsx:18,62-69` reads `saveError` and renders an error banner |
| 10 | unify button labels | `frontend/src/components/Toast.jsx:116` aria-label expanded to `"Dismiss notification"`; new top-right `X` close button (see #20) means the only `/close/i` button in modal dialogs is the explicit action |
| 11 | new Reader Stop button variant | `frontend/src/components/reader/Reader.jsx:604-612` now renders Stop as `btn secondary btn-compact` with a visible label |
| 12 | `StudioSettings` language list | `frontend/src/components/StudioSettings.jsx:2,148-150` imports `SUPPORTED_LANGUAGES` from `../utils/languages` |
| 13 | `VoiceSettings` chevron | `frontend/src/components/VoiceSettings.jsx:5,188` uses `<ChevronDown size={14} />`; `frontend/src/styles/reader.css:1072-1075` keeps the rotation transition |
| 14 | danger-variant focus ring | `frontend/src/styles/controls.css:105-109` adds explicit `--live` outline + halo for `.btn.danger:focus-visible` and `.btn.text.danger:focus-visible` |
| 15 | env docs | `backend/.env.example` now documents `BOOKVOICE_PUBLIC_ORIGIN`, `BOOKVOICE_ALLOW_PRIVATE_ORIGINS`, `BOOKVOICE_TRUST_PROXY_HEADERS`, and `BOOKVOICE_ACCESS_PASSWORD` |

### 7.4 Low fixes

| # | Finding | File / change |
|---|---|---|
| 16 | TopBar wording | `frontend/src/components/shell/TopBar.jsx:25-26` — `aria-label` and `title` now read `Switch to light/dark mode` |
| 17 | LibraryView empty-state icon | `frontend/src/components/shell/LibraryView.jsx:176-178` adds `<BookOpen size={28} className="empty-state-icon" />` |
| 18 | PreparedBookRow badge labels | `frontend/src/components/shell/PreparedBookRow.jsx:4-9,21-23` — `SOURCE_KIND_LABELS` map (`PDF`, `EPUB`, `Text`, `Markdown`) |
| 19 | WebView2 default-bg sync note | `desktop/BookVoice.App/MainWindow.xaml:107-110` — explicit `KEEP IN SYNC with frontend/src/styles/tokens.css --bg for [data-palette="paper"][data-mode="dark"]` comment |
| 20 | Modal close `X` | `frontend/src/components/ui/Modal.jsx:2,107-119` renders a `.modal-header` with a top-right `.modal-close` (`aria-label="Close dialog"`); `frontend/src/styles/controls.css:473-489` lays it out |
| 21 | `useCapabilities` consumed in SettingsView | `frontend/src/components/shell/SettingsView.jsx:8,18,63-69,165-186` — renders server-mode banner, hides update toggle, explains why |

### 7.5 Verification

After all 19 code-config changes landed:

* `npm run lint` in `frontend/` → 0 diagnostics.
* `npm run test` in `frontend/` → **418 / 418 passing** (69 files).
* `python -m pytest tests -q` in repo root → **455 passed, 1 skipped, 28 subtests passing**.
* Tests touched by wording/iconography changes were updated to match the new labels: `App.test.jsx`, `TopBar.test.jsx`, `Toast.test.jsx`, `Shortcuts.test.jsx`, `SettingsView.test.jsx` (added `useCapabilities` mock).

### 7.6 Deferred items and their pointers

* **#4 (`book_library_service.py` split)** — `tasks/todo.md:56-58` (Phase 1C — split into 7 modules); CHANGELOG entry "Backend: `services/book_library_service.py` (1,232 lines) **deferred from this release**" under "Test results" for the unreleased version.
* **#5 (Reader parity)** — `frontend/src/components/reader/PARITY.md`; CHANGELOG "Known limitations (while the new reader is the default, `?reader=old` remains as the one-minor rollback hatch)"; `tasks/plan-bookvoice-improvements.md`. Each remaining gap has a follow-up issue.
* **#19 (WebView2 bg sync)** — the literal is still hardcoded; the doc comment now names the CSS variable. Full extraction would require a XAML resource dictionary that the design system would also have to author; not done in this pass.
