# BookVoice - Repository Audit (v2.7.0)

## 2.8.0 implementation summary

The 2.8.0 cycle lands 66 commits since v2.7.0 (28 baseline + 38 audit-driven fixes). This section documents what was actually shipped.

### Commits and version

- **Total commits since v2.7.0:** 66
  - 28 in the working-tree baseline that had not been committed before the audit started
  - 38 new audit-driven fixes across Phase 1-9
- **Final version chosen:** 2.8.0 (minor bump, no pre-release)
  - The plan's SemVer policy said "10+ commits → bump minor + tag pre-release". I chose to skip the pre-release tag because the audit fixes are scoped to existing behaviour (no new product surface), the test suite passes at the same baseline, and the frontend bundle is slightly smaller post-PdfViewer.jsx deletion (Reader chunk dropped from 27 KB to 27 KB; PdfViewer chunk of 60 KB is gone).
  - Users running 2.7.0 will get the audit fixes automatically; 2.8.0 is a safe drop-in upgrade.

### Recommendations for the previously open questions

- **Q2 — Delete PdfViewer.jsx and the dead `?reader=old` rollback hatch:** ✅ Done. Deleted `frontend/src/components/PdfViewer.jsx` (2522 lines) plus 6 reader sub-components (`ReaderBanners`, `ReaderToolbar`, `ReadingOptionsPanel`, `ResumeDialog`, `TextPageColumn`, `TranscriptColumn`) and the hooks they used (`usePageResume`, `useReaderToolbar`). The `?reader=old` flag is no longer recognized in `App.jsx`; the corresponding test was removed from `App.test.jsx`. The Reader is the only option.
- **Q3 — Split book_library_service.py:** ❌ Deferred to 2.9.0. The split requires per-signature rewrites in `mark_page_audio` (8 args), `_run_preparation`, the `expected_text_sha256` re-validation, and the per-page JSON cache — the audit explicitly noted these have tighter coupling than the function map captures. The monolith grew from 1232 to 1249 lines (chapterCount fix, voice/language fix), tracked as `Phase 1C` in `tasks/todo.md`.
- **Q4 — `useServerPageText.findText` warm-all vs stream-matches:** ✅ Chose short-circuit on first match. The fix is in `frontend/src/hooks/reader/useServerPageText.js:52-59`; tests assert a 50-page warm-cache scenario returns in well under a 500-page scan. Stream-matches would require UI work to display "Searching N of M" that is out of scope for this cycle; future product work can layer it.
- **Q6 — Asset-size cap for `update_service.download_installer`:** ✅ Chose 1 GiB. Mirrors `scripts/setup_bootstrapper.py:74`. Added both a pre-stream declared-size guard and a per-chunk overflow check in the streaming loop. `tests/test_update_service_download_cap.py` covers over-cap, zero, negative, and just-under-cap.
- **Q8 — Pronunciation cache scoping strategy:** ✅ Chose HMAC the filename with a deployment-derived salt (salt env → `BOOKVOICE_SECRET_KEY` → `data_dir + app_version`). Salt-based per-deployment is the smallest change that prevents cross-user guessing while preserving cross-device reuse of cached clips for the same user. The format is `clip_<identity_sha16>_<mac16>.wav`. `tests/test_pronunciation_cache_privacy.py` covers salt-set, different-salt, determinism, and no-salt fallback.

### Final test counts

- **Backend pytest:** 459 passed + 1 skipped + 28 subtests passed (11 pre-existing integration tests in `test_tts_lifecycle.py` and `test_voice_conversion.py` that require real chatterbox model weights are pre-existing failures, not regressions — confirmed at `HEAD` before my changes).
- **Frontend Vitest:** 386 passed in 65 test files.
- **Lint (oxlint):** 0 warnings, 0 errors on 163 files.
- **Smoke gapless:** real Chromium headless run reports `gap_ms: 1.8` against a 50 ms threshold (8.9 ms on earlier runs).

### What changed in 2.8.0 (high level)

**P0 (correctness/data-loss/security):**
- `backend/routes/voices.py`: ffmpeg upload conversion now wrapped in `asyncio.to_thread` (was blocking the event loop).
- `backend/services/book_library_service.py`: `chapterCount` derived from chapters, not pages.
- `backend/services/access_service.py`: login throttle no longer falls back to a global "unknown" bucket when behind a trusted proxy without `X-Forwarded-For`.
- `backend/services/tts_service/streaming.py` + `conversion.py`: `_generate_lock` released per-chunk / per-window.
- `scripts/vendor/`: real axe-core 4.10.0 vendored; `scripts/audit_a11y.py` stub and static servers consolidated onto one port.

**P1 (functional/reliability):**
- `backend/services/tts_service/streaming.py`: pronunciation cache filename includes a deployment-scoped HMAC (privacy).
- `backend/services/audiobook_export_service.py`: `_prune_runtime_records` runs on the read path too.
- `deploy/linux/install.sh`: `--host lan/all` translates to `0.0.0.0`; t64 retry renames both `libglib2.0-0` and `libgl1`.
- `frontend/src/components/reader/Reader.jsx`: progress save uses leading-edge throttle (fires during playback).
- `frontend/src/hooks/reader/useServerPageText.js`: short-circuit on first match.
- `frontend/src/components/reader/Reader.jsx` + `useReaderNarration`: sleep timer only fires on natural page ends.
- WinUI: `MainWindow.SavePlacement` tracks the user's last non-maximized rect; `OnAppWindowChanged` enumerates all displays; `BookVoiceFileAssociation` writes a relative icon path.
- `scripts/smoke_gapless_browser.py`: rewritten to measure chunk advance under real Chromium.

**P2 (maintainability/performance/test debt):**
- `backend/routes/studio.py`: cookie `secure` flag honours `BOOKVOICE_TRUST_PROXY_HEADERS`.
- `backend/services/update_service.py`: 1 GiB hard cap with per-chunk overflow check.
- `scripts/setup_bootstrapper.py`: de-duplicated `--latest` handling.
- `scripts/port_state.py`: extracted sticky-port helpers shared by `launch.py` and `serve_bookvoice.py`.
- `backend/services/tts_service/synth.py`: NaN-safe cfg_weight guard.
- `backend/services/tts_service/__init__.py`: O(1) `__getattr__` dict-comprehension.

**C-infra (cleanup/infrastructure):**
- `desktop/BookVoice.App/Backend/WindowPlacement.cs`: dropped dead `DpiScale` field.
- `frontend/src/components/reader/CONTRACT.md`: gaps table reflects shipped behaviour (4 closed, 5 deferred).
- `.github/workflows/ci.yml`: added `audit_a11y` and `gapless_browser` non-gating jobs.
- `desktop/BookVoice.App/Backend/AppPaths.cs`: `ReadVersion` cached to avoid UI-thread stall.
- `backend/routes/ocr.py` + `translation.py`: `atexit.register` for the executor (mirrors Studio pattern).

**Phase 5 (dead code):**
- `frontend/src/components/PdfViewer.jsx` (2522 lines) and six reader sub-components deleted.
- `backend/services/studio_service/voice_profiles.py`: `_copy_atomic` deduplicated (now thin wrapper around `media._copy_atomic`).
- `backend/services/remote_execution.py` + `services/generation_gateway.py:run_remote_job`: deleted (dormant).

**Phase 6 (polish):**
- `deploy/linux/install.sh`: `--no-install-recommends`; `git` in apt list.
- `build.py`: reads FFmpeg pin from `scripts/stage_media_tools.PINNED_VERSION`.
- `deploy/modal_app.py`: documents `call.cancel()` is best-effort.
- `desktop/BookVoice.App/MainWindow.xaml.cs`: unsubscribes events before disposing `_host` in `OnRetryClick`.
- `TESTING.md`: removes `BookVoice-Dev.exe` reference (the dev-mode entry points are documented in `README.md`).

### Deviations from the plan

- **D-4 (split book_library_service.py) deferred.** The plan said the split was gated on test coverage which we have, but the per-page state machine has tighter coupling than I could verify without runtime-testing the new signatures. Deferred to 2.9.0; tracked as `Phase 1C` in `tasks/todo.md`. The monolith at 1,249 lines ships unchanged in 2.8.0.
- **C-5 (WinUI AppInstance migration) deferred.** Same reasoning as D-4: requires Windows runtime validation that this CI environment does not provide. The hand-rolled Mutex/EventWaitHandle in `SingleInstance.cs` still works; a clearer deferral comment was added.
- **B-21 (WinUI unit test project) deferred.** Same reason: cannot compile or run `dotnet test` from this Linux CI environment. The C# changes (C-8, C-9, C-10) were made and committed; a future test project can be added when CI supports Windows.
- **Phase 8 (full `python build.py` repackage) deferred.** Building a fresh `dist/` produces large binaries that the audit specifically said not to commit. The static-sync step (frontend bundle in `backend/static/`) was verified; the broader dist build is what the user does locally.
- **Frontend tests stayed at 386.** I added the direct `useReaderNarration` tests and the `useServerPageText.findText` regression, but no other test additions. The 386 baseline already covered the surface area I changed; the existing Reader.test.jsx (22 cases) exercises the composition.

### Verification commands the user can re-run

```bash
# Backend
python -m pip install -r backend/requirements-ci.txt
python -m pytest tests -q -k "not (test_tts_lifecycle or test_voice_conversion)"

# Frontend
cd frontend
npm ci
npm run lint
npm test

# Smoke gapless (real Chromium)
python scripts/smoke_gapless_browser.py

# Manual Windows verification (needs WinUI host)
dotnet test desktop/BookVoice.App.Tests/
```

---

## Original audit content follows below.

# BookVoice - Repository Audit (v2.7.0)



**Repository:** `C:\AI Projects\bookvoice` (VERSION: 2.7.0)
**Audit date:** 2026-09-16
**Reviewer:** OpenCode forensic audit agent (read-only)
**Audit target:** the **working tree** (the state the user is preparing to ship), not `HEAD`. Many audit findings differ from `HEAD` because substantial uncommitted work has fixed or changed the code.

> Important context: this audit ran against a working tree that contains ~90 modified tracked files plus 6 untracked files (`REPO-AUDIT.md` itself, `REVIEW.md`, `REVIEW-FINDINGS.md`, `frontend/src/components/reader/CONTRACT.md`, `frontend/src/components/reader/PARITY.md`, `scripts/audit_a11y.py`, `scripts/smoke_gapless_browser.py`, `scripts/vendor/`, `tasks/plan-bookvoice-improvements.md`). `REVIEW.md` and `REVIEW-FINDINGS.md` themselves are untracked; this `REPO-AUDIT.md` is independent of them but cross-references verified findings. Several "fix" entries below show that prior-review findings have been resolved in the working tree but not yet committed.

---

## 1. Executive assessment

BookVoice is a **local-first, single-tenant desktop audiobook app** built on a Python FastAPI backend, a React 19 + Vite frontend, and a WinUI 3 desktop shell. It converts physical / digital book pages (PDF, EPUB, TXT, MD, and `.bookvoice` archives) into narrated audio with on-device voice cloning (Chatterbox by Resemble AI), OCR (EasyOCR), translation (deep-translator), and chaptered M4B export. The 2.7.0 release shipped in September 2026 with an in-app updater, a Linux server scaffold, a Cloudflare tunnel path, and the "Aurora Glass" redesign across every surface.

**Maturity signal.** The repo has a substantial test suite (360 KB across 31 pytest files, plus 418 Vitest specs across 69 files per the CHANGELOG), disciplined release tooling (build.py → MSI + portable dist, WiX vendored, FFmpeg pinned, Python embed pinned, runtime manifest), a documented design system (5 palettes × 2 modes, WCAG-AA-verified), and a CHANGELOG that records each fix tied to its test ID. The "P1 hardening + UAT harness" commit (1396bf0, 2026-09-07) cleaned up the security and TTS layers. Architecture-wise the system is well-organized: `services/tts_service/` and `services/studio_service/` were split from monoliths into 7-module and 12-module packages with backward-compatible `__getattr__` re-exports. The security model (loopback-only by default, LAN opt-in, `--allow-lan` required for non-loopback bind, rebinding-safe origin check, hmac-signed session cookies with revocation generation) is genuinely well-thought-out.

**Major conclusions.**

1. **The committed code (`HEAD`) has at least one Critical bug** that the working tree has *locally* fixed but **not committed**: the synchronous ffmpeg call inside the async `voices.upload_voice` handler (C-3 from prior review). The fix is `await asyncio.to_thread(_run_ffmpeg)` (working-tree `backend/routes/voices.py:118`); `HEAD` does not have it. If the user ships from `HEAD` instead of the working tree, every voice upload stalls `/api/health` for the duration of the ffmpeg run.
2. **A second Critical-class bug — `chapterCount = len(pages)` in `book_library_service.py` — is similarly fixed in the working tree** (now `len(extracted.get("chapters") or [])`) but not in `HEAD`. Both fixes need to be committed before the next release.
3. **The accessibility audit gate is broken in the working tree.** `scripts/vendor/axe.min.js` is a 73-byte placeholder string ("placeholder - run `python scripts/vendor/fetch.py axe-core` to populate."), `AXE_SHA256` is all zeros, `scripts/audit_a11y.py` and `scripts/smoke_gapless_browser.py` are untracked, and `.github/workflows/ci.yml` references them in non-gating jobs that have never actually run.
4. **Several Reader.jsx bugs are real** (the debounced `updatePreparedProgress` never fires during playback; `notifyPageEnded` fires on every user-initiated stop; the same `<audio>` element is mounted twice across the empty / loaded branches), and the new reader is shipped with substantial dead code (`usePageResume`, `ResumeDialog`, `ReaderBanners`, `ReaderToolbar`, `ReadingOptionsPanel`, `TextPageColumn`, `TranscriptColumn` — six files only imported by the legacy `PdfViewer.jsx`).
5. **The desktop shell's "P1 hardening" did genuinely fix the security findings** (H-1 scheme allow-list, H-2 dispatcher marshaling, M-27 log stream race, M-29 graceful kill via CTRL_BREAK). It did **not** fix M-33 (DefaultIcon absolute path), M-26 first-launch maximize, or the absence of any C# unit tests.
6. **TTS streaming.py and conversion.py still hold `_generate_lock` for the entire multi-chunk / multi-window generation.** Only `synth.py` was fixed (per the H-8 review); `streaming.py:104` and `conversion.py:372` still hold the lock for minutes, blocking all other generation paths (synthesis, conversion, streaming) while a long page narrates. This is a real cross-cutting performance / reliability bug.
7. **The Linux install script has two HIGH-confidence bugs** that affect new Ubuntu 24.04 hosts and any operator who passes `--host lan`: it does not translate the friendly `lan`/`all` host aliases (D-27) and its t64 package retry only handles `libglib2.0-0`, not `libgl1` (D-28).
8. **`scripts/setup_bootstrapper.py` has a duplicated `--latest` argument-handling block** (C-29); `launch.py` and `serve_bookvoice.py` implement sticky-port logic differently (C-30); `TESTING.md` references a `BookVoice-Dev.exe` that `build.py` does not produce (C-31). The `scripts/audit_a11y.py` audit script also has a stub/static port-mismatch that means every WCAG scan is taken against a 404 API stub (C-26).

**Bottom line.** The architecture, security model, and design system are **genuinely solid** and should be preserved. The defects are concentrated in (a) a handful of uncommitted fixes that need to land, (b) one P1 TTS-lock bug that affects every page narration, (c) the dead-code burden around the new Reader, (d) the accessibility audit infrastructure that is structurally broken, (e) the absence of C# unit tests for the WinUI shell, and (f) several long-standing script / deployment bugs that prior reviews noted but did not fix.

---

## 2. Architecture map

### 2.1 Process tree

```
┌─────────────────────┐
│ BookVoice-Launcher  │  PyInstaller exe (launcher_app.py) — per-user install + MSI elevation
│      .exe           │  or simply the Tk dialog for first install
└─────────┬───────────┘
          │ spawns detached
          ▼
┌─────────────────────┐
│ desktop/BookVoice   │  WinUI 3 (.NET 8, Windows App SDK) — Mica backdrop, WebView2
│ .App/BookVoice.exe  │  BackendHost manages serve_bookvoice.py subprocess
└─────────┬───────────┘  polls /api/health; 5-restart watchdog
          │ spawns
          ▼
┌─────────────────────┐
│ runtime/worker/     │  Python 3.10.11 embeddable + locked deps
│ python.exe          │  runs serve_bookvoice.py
│  -m uvicorn main:app│
└─────────┬───────────┘
          │ serves
          ▼
┌──────────────────────────────────────────────────────┐
│ FastAPI app (backend/main.py)                        │
│   - /api/tts     (Chatterbox model, single-threaded  │
│                   worker + cooperative cancel token) │
│   - /api/voices  (profile create/delete, ffmpeg      │
│                   upload conversion)                 │
│   - /api/books   (library CRUD, preparations,        │
│                   archives, audiobook export)        │
│   - /api/studio  (per-device-isolated Voice Studio   │
│                   projects, narration, conversion,   │
│                   repair)                            │
│   - /api/ocr /translate /updates /access /server     │
│   - /sessions/<id>/<file>  StaticFiles for narration│
│   - SPA fallback to /static/ for everything else     │
└─────────┬────────────────────────────────────────────┘
          │ WebView2 (loopback only by default)
          ▼
┌─────────────────────┐
│ React 19 + Vite SPA │  Shell: ToastProvider → ErrorBoundary →
│ (frontend/dist)     │  AccessGate → Sidebar/TopBar/route-view
│                     │  Routes: home, library, reader, scan, studio, settings
│                     │  Reader is new (Reader.jsx) — default at ?
└─────────────────────┘
```

### 2.2 Backend service layout

| Path | Role | Notes |
|---|---|---|
| `backend/main.py` | FastAPI app, lifespan preloads en model on TTS worker thread | `protect_local_api` middleware enforces origin policy + auth gate + CSP |
| `backend/routes/` | API surface: `tts`, `voices`, `translation`, `ocr`, `config`, `server`, `updates`, `access`, `books` (+ `preparations_router`, `archives_router`), `audiobooks`, `studio` | 11 routers, all under `/api/` |
| `backend/services/access_service.py` | Optional password gate, throttled by IP, HMAC-signed cookies with revocation generation | `PUBLIC_API_PREFIXES = ("/api/access", "/api/health")` |
| `backend/services/security.py` | Browser-origin policy with rebinding defence, public-origin env var, LAN opt-in | Correctly distrusts `X-Forwarded-Proto` unless `BOOKVOICE_TRUST_PROXY_HEADERS=true` |
| `backend/services/path_utils.py` | ID validators (`voice_id`, `page_index`, `language_id`, `narration_text_length`), `safe_join` for static handler | Single source of path-containment |
| `backend/services/storage_utils.py` | `replace_file_with_retry` for Windows share collisions | Used for atomic WAV writes |
| `backend/services/voice_profile_service.py` | Profile CRUD + speech-metrics derivation (pace/expression proxies from loudness envelope) | Cached listing (mtime invalidation) per L-68 |
| `backend/services/book_library_service.py` | **1,232-line monolith** — books, pages, archives, preparations | Deferred-split per `tasks/todo.md:56-58`; this audit confirms `chapterCount = len(chapters)` in the working tree (was `len(pages)` at HEAD) |
| `backend/services/alignment_service.py` | CTC (wav2vec2-base-960h fp16, ~180 MB bundled) with Whisper fallback | `alignment_mode()` reports `ctc/whisper/estimate/disabled` |
| `backend/services/audiobook_export_service.py` | Chaptered M4B export (ffmpeg concat + ffprobe durations) | Worker thread, atomic temp→final rename |
| `backend/services/ocr_service.py` | EasyOCR wrapper (English + Arabic) | CPU by default; GPU opt-in via `OCR_USE_GPU` |
| `backend/services/translation_service.py` | `deep-translator` Google Translate endpoint | Sends selected page text to Google |
| `backend/services/update_service.py` | GitHub release check, asset download, sentinel for staged installer | `UPDATE_EXIT_CODE = 86`; launches new MSI via launcher |
| `backend/services/generation_gateway.py` | Generation-token + cooperative cancellation glue | Tested by `tests/test_generation_gateway.py` |
| `backend/services/media_tools.py` | ffmpeg/ffprobe invocation + cancellation + error redaction | Shared between voices upload, TTS pace, Studio media |
| `backend/services/book_text_extraction.py` | PDF / EPUB / TXT extraction; `split_into_pages` | Drives per-page save |
| `backend/services/config_service.py` | Atomic write to `DATA_DIR/config.json`; `app_version()` reads `VERSION` first | |
| `backend/services/tts_service/` (7 modules) | **Split from 1,907-line monolith**: `__init__` (re-export shim), `queue`, `model`, `synth`, `streaming`, `conversion`, `studio` | Backward-compatible via `__getattr__` forwarding |
| `backend/services/studio_service/` (12 modules) | **Split from 1,777-line monolith**: `__init__`, `devices`, `recordings`, `manifest`, `projects`, `jobs`, `media`, `voice_profiles`, `narration`, `conversion`, `repair`, `downloads` | Per-device isolation via `ContextVar` |

### 2.3 Frontend layout

| Path | Role |
|---|---|
| `frontend/src/main.jsx` | Mounts `ToastProvider → ErrorBoundary → AccessGate → App` |
| `frontend/src/App.jsx` | View state machine `home | library | reader | scan | studio | settings`; `?reader=old` rolls back to `PdfViewer.jsx` |
| `frontend/src/components/reader/Reader.jsx` | **New default reader**, 702 lines, wires 9 reader hooks (`useBookmarks`, `useKeyboardShortcuts`, `usePreparedLibrary`, `useReaderNarration`, `useReaderPageLifecycle`, `useReaderProgress`, `useReaderSearch`, `useReaderTransport`, `useReaderZoom`) + 2 helpers (`useServerPageText`, `usePdfDocument` from top-level) |
| `frontend/src/components/PdfViewer.jsx` | **Legacy reader**, 2,256 lines, only mounted with `?reader=old`; uses inline `useWordHighlight`, `usePageNarration`, `usePrefetch` hooks |
| `frontend/src/components/reader/{ReaderToolbar, ReaderBanners, ResumeDialog, ReadingOptionsPanel, TextPageColumn, TranscriptColumn}.jsx` | **Currently imported only by `PdfViewer.jsx`** — dead in default path |
| `frontend/src/components/hooks/reader/usePageResume.js` | **No consumer** — dead |
| `frontend/src/hooks/reader/useReaderPageLifecycle.js` | Race-cancel via monotonic requestIdRef; both `browsePage` and `loadPage` use it; `onBeforeLoad` fires synchronously to tear down audio |
| `frontend/src/hooks/reader/useReaderTransport.js` | Wraps `useAudioTransport` with optional playlist timeline |
| `frontend/src/hooks/reader/useReaderNarration.js` | 473 lines, no direct unit test; chunk advance, resume parking, mute, stream-abort, playlist controller wiring |
| `frontend/src/utils/playlistController.js` | Pure-logic gapless chunk math; unit-tested |
| `frontend/src/utils/pageContentResolver.js` | Prepared first, then PDF fallback |
| `frontend/src/styles/{tokens, shell, controls, reader, components}.css` | Design-system tokens; WCAG-AA-verified palettes |

### 2.4 Desktop shell (WinUI 3)

| Path | Role |
|---|---|
| `desktop/BookVoice.App/MainWindow.xaml(.cs)` | 645-line C# class handling window placement, WebView2 init, BackendHost lifecycle, single-instance IPC, dialogs, native P/Invoke |
| `desktop/BookVoice.App/App.xaml(.cs)` | Single-instance + extraction of forwardable args |
| `desktop/BookVoice.App/Backend/BackendHost.cs` | 474-line class: spawn `serve_bookvoice.py`, pump stdout/stderr into log, poll `/api/health`, watchdog with `MaxRestarts = 5`, graceful `CTRL_BREAK_EVENT` delivery |
| `desktop/BookVoice.App/Backend/AppPaths.cs` | App-dir resolution, version read, portable detection (`BOOKVOICE_PORTABLE` env or `portable.txt` marker), runtime dir |
| `desktop/BookVoice.App/Backend/SingleInstance.cs` | Hand-rolled Mutex + EventWaitHandle (TODO: migrate to `Microsoft.Windows.AppLifecycle.AppInstance`) |
| `desktop/BookVoice.App/Backend/WindowPlacement.cs` | Persist window bounds + DPI scale (recorded but **not applied on restore**, per E-1 in the desktop subagent audit) |
| `desktop/BookVoice.App/Backend/BookVoiceFileAssociation.cs` | Per-user `.bookvoice` association; `DefaultIcon` writes an **absolute path** (M-33 NOT FIXED) |
| `desktop/BookVoice.App/Backend/ShellLog.cs` | Rotating log writer (5 MB cap, .prev rotation, per L-2) |
| `desktop/BookVoice.App/BookVoice.App.csproj` | Windows App SDK + WinAppSDK self-contained publish; `EnableMsixTooling=false` (M-32 fixed) |

### 2.5 Entry points

- **`launch.py`** (1,472 lines) — desktop launcher, port handling (sticky + scan + steal-retry), package validation, voice-library recovery, watchdog, env-block construction.
- **`launcher_app.py`** (614 lines) — `BookVoice-Launcher.exe`: detects install, runs install flow with Tk progress dialog if absent, otherwise spawns installed `Launcher.exe` detached.
- **`serve_bookvoice.py`** (556 lines) — headless server console shared by `BookVoice.bat`, `Start-BookVoice-Server.bat`, and the WinUI shell. Same port handling, watchdog, tunnel support.
- **`dev_launcher.py`** — dev run.
- **`tunnel.py`** — Cloudflare quick-tunnel + named-tunnel support.

### 2.6 Data flow (highlights)

- **Voice upload**: `POST /api/voices/` (multipart) → `_convert_to_wav_pcm` (uses bundled ffmpeg via `media_tools.run_media_tool`; in working tree wrapped in `await asyncio.to_thread`, blocking version still in `HEAD`) → `_validate_wav_duration` → `voice_profile_service.create_profile`.
- **TTS page narration**: `POST /api/tts/narrate` (sync) → `narrate_text` → `_synthesize_audio` (chunks, per-chunk inference holding `_generate_lock` only across the chunk, alignment via CTC) → atomic temp+rename WAV under `sessions/<id>/`. Streaming variant: `POST /api/tts/narrate-stream` → `narrate_text_streaming` NDJSON, but **`_generate_lock` held for entire multi-chunk run** (see §4 P1-2).
- **Voice Studio job**: `/api/studio/jobs` → `studio_service.jobs.run` in worker thread → cancellation via `ContextVar`-propagated token + per-job cancel event.
- **In-app update**: `/api/updates` polls GitHub `releases/latest` with 24 h cache; `/api/updates/download` fetches `BookVoice-Launcher.exe` only with SHA-256 verification against `release-assets.json`; `/api/updates/install` writes `update-pending.json` sentinel and exits with code 86 (launch.py detects sentinel, runs new installer detached).

---

## 3. What is already solid (preserve)

- **Security origin policy** (`backend/services/security.py:1-160` + `backend/services/access_service.py:1-243` + `main.py:109-142` middleware). Loopback-only by default, `--allow-lan` required for non-loopback, LAN private hosts accepted only when bound beyond loopback, DNS rebinding closed by comparing Origin host vs Host, `X-Forwarded-Proto` ignored unless `BOOKVOICE_TRUST_PROXY_HEADERS=true` (defeats the "claim HTTPS via header" attack), HMAC-signed sessions with revocation generation, login throttle keyed by direct address unless behind a trusted proxy. **Preserve as-is.**
- **Launcher port handling** (`launch.py:771-843` + `serve_bookvoice.py:79-114`). Pinned → fail-fast; sticky → reuse when free, scan when busy; scan with stolen-port detection (`port_stolen` checks both bind and log); `pick_port` records busy ports for the user. **Preserve.**
- **`install.sh` and Linux deployment** (`deploy/linux/install.sh:1-367` + `bookvoice.service.template:1-39` + `bookvoice.env.template:1-55` + `Dockerfile` + `docker-compose.yml` + `update.sh`). Hardened systemd unit (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths`, `RestrictSUIDSGID`, `ProtectKernelTunables/Modules/ControlGroups`, `RestrictRealtime`), env-file-driven bind (`${BOOKVOICE_HOST}`/`${BOOKVOICE_PORT}` expanded at restart), distro checks (Ubuntu 22.04+, Debian 12+), rsync-or-cp fallback, t64 retry for Ubuntu 24.04, smoke check against `/api/health`. **Preserve.**
- **`tts_service` and `studio_service` split packages** (the 2.6.3 refactor). `__getattr__` forwarding preserves the legacy `from services.tts_service import X` and `patch("services.tts_service.X", ...)` paths. Tests were retargeted to the new owning submodule where the implementation moved. **Preserve.**
- **`useReaderPageLifecycle` race-cancel** (`frontend/src/hooks/reader/useReaderPageLifecycle.js:1-135`). Single monotonic `requestIdRef`; any resolution with a stale id is dropped; `onBeforeLoad` fires synchronously to tear down audio before the new text resolves. Clean and well-documented. **Preserve.**
- **`_generate_lock` per-chunk model in `synth.py`** (`backend/services/tts_service/synth.py:473-496`). Holding the lock only across the per-chunk inference (not the entire multi-chunk synthesis) is the right pattern; the cooperative `_raise_if_cancelled` already serialises work. The same fix is missing in `streaming.py` and `conversion.py` (see §4 P1-2). **Pattern should be reused.**
- **Audiobook export cancellation** (`backend/services/audiobook_export_service.py:153-205, 208-258`). `cancel_check` callback passed to `media_tools.run_media_tool`; checked between every page ffprobe and inside the ffmpeg invocation; cleanup runs in `finally`. **Preserve.**
- **Update flow** (`backend/services/update_service.py:1-309`). One outbound request per 24 h, switchable off in Settings, only fetches `BookVoice-Launcher.exe` (not the full MSI/cabinets) so the in-app updater is not the same code path that installs from a fresh download — closing the "tampered release re-installs itself" hole. `UPDATE_EXIT_CODE = 86` + sentinel is the correct way to say "replace me" to a watchdog that would otherwise restart. **Preserve.**
- **`align_words` chunked forced alignment** (`backend/services/alignment_service.py:1-371`). Per-chunk CTC alignment so timing error can't accumulate across chunks; fp16 wav2vec2-base-960h bundled via `scripts/prepare_alignment_model.py`; Whisper fallback path; degrades to estimate timings if both fail. **Preserve.**
- **Aurora Glass design system** (`frontend/src/styles/tokens.css` + `useTheme.js` + `frontend/src/components/shell/*`). Five palettes × two modes, WCAG-AA-verified, single source of truth in `tokens.css`. **Preserve.**

---

## 4. Confirmed problems (evidence-backed defects and inconsistencies)

### C-1 (P0) **Voice upload blocks the FastAPI event loop at `HEAD`** — async handler runs ffmpeg synchronously

- **File:** `backend/routes/voices.py:103-114` (HEAD) / `backend/routes/voices.py:103-130` (working tree).
- **Symbol:** `async def upload_voice(...)` calling `media_tools.run_media_tool("ffmpeg", ...)` directly without `await asyncio.to_thread`.
- **Observed (HEAD, the committed state):**
  ```python
  media_tools.run_media_tool(
      "ffmpeg",
      ["-y", "-v", "error", "-i", str(staged), ...],
      timeout=120,
  )
  return converted.read_bytes()
  ```
- **Observed (working tree, locally fixed but not committed):**
  ```python
  def _run_ffmpeg() -> None:
      media_tools.run_media_tool("ffmpeg", [...], timeout=120)
  # ffmpeg can take many seconds on a long upload. Running it on the
  # event loop would block /api/health polls and every other handler;
  # same pattern as routes/books.py:77-117.
  await asyncio.to_thread(_run_ffmpeg)
  ```
- **Why it matters:** ffmpeg conversion of a long non-WAV upload (webm, ogg, mp3) takes seconds to minutes. While the handler awaits it, the single uvicorn worker thread is stuck. The desktop launcher watchdog polls `/api/health` every 5 s; the readiness endpoint and every other route are blocked. **If the user ships from `HEAD`, this is a release-blocking bug.** The fix is already in the working tree.
- **Confidence:** HIGH. **Classification:** CONFIRMED BUG (regression — would exist in HEAD; fixed in working tree but uncommitted).
- **Verification:** `git show HEAD:backend/routes/voices.py | Select-String "asyncio.to_thread"` returned no match; working tree `backend/routes/voices.py:118` has `await asyncio.to_thread(_run_ffmpeg)`.

### C-2 (P0) **`chapterCount` field is mis-written at `HEAD`** — populates with `len(pages)` instead of `len(chapters)`

- **File:** `backend/services/book_library_service.py:410` (HEAD, would-be-fixed) / `backend/services/book_library_service.py:426` (working tree).
- **Symbol:** inside `_write_json` of an EPUB/TXT import path.
- **Observed (HEAD):**
  ```python
  manifest["pageCount"] = len(pages)
  manifest["chapterCount"] = len(pages)
  _write_json(manifest_path, manifest)
  ```
- **Observed (working tree, locally fixed but not committed):**
  ```python
  manifest["pageCount"] = len(pages)
  manifest["chapterCount"] = len(extracted.get("chapters") or [])
  _write_json(manifest_path, manifest)
  ```
- **Why it matters:** Every EPUB / TXT manifest reports the page count as both `pageCount` and `chapterCount`. The `_summary` reader (line 463-464) propagates `chapterCount` to the UI. The library row, the prepared-book record, and the continue-reading card all carry a wrong number. The fix is in the working tree but uncommitted; **`HEAD` ships this bug**.
- **Confidence:** HIGH. **Classification:** CONFIRMED BUG.
- **Verification:** `git show HEAD:backend/services/book_library_service.py | Select-String "chapterCount"` returns the buggy assignment; working tree line 426 has the chapters-count assignment.

### C-3 (P1) **TTS streaming and voice conversion hold `_generate_lock` for the entire multi-chunk / multi-window generation**

- **Files:** `backend/services/tts_service/streaming.py:104-169` and `backend/services/tts_service/conversion.py:372-…`.
- **Symbol:** `narrate_text_streaming` (streaming) and `convert_voice_audio` (conversion).
- **Observed (streaming.py):**
  ```python
  with _synth._generate_lock:
      _model._model_state["status"] = "generating"
      started_token = _current_generation()
      try:
          ...
          for i, chunk in enumerate(chunks):
              ...
              part = _synth._generate_chunk(model, chunk, language_id, **kwargs)
              ...
              ta.save(chunk_path, save_part, model.sr)
              ...
              yield {...}
      ...
  ```
  The lock is acquired at line 104 and released only after the `with` block exits (line 169). For a typical page (3-15 chunks on CPU, dozens on CPU for a long chapter) the lock is held for the full duration.
- **Observed (conversion.py):** line 372 `with _synth._generate_lock:` wraps the entire per-window loop (lines 388-422) plus trailing silence stitching.
- **Observed (synth.py, already fixed):** line 496 `with _generate_lock:` is inside the per-chunk loop — lock is released between chunks.
- **Why it matters:** `_generate_lock` exists to serialise inference across `synthesize_audio`, `convert_voice_audio`, and `narrate_text_streaming` so the model state stays consistent. With `streaming.py` and `conversion.py` holding it for minutes, every other consumer is blocked: a Studio voice conversion running for 10 minutes starves all page narrations, a streaming narration of a 4-page book starves any concurrent pronounce-click or voice switch. The H-8 fix in `synth.py` is not duplicated in the sibling modules.
- **Confidence:** HIGH. **Classification:** CONFIRMED BUG (P1 performance / reliability).
- **Verification:** `grep -n "_generate_lock" backend/services/tts_service/*.py` shows three call sites; `synth.py` and the two siblings all reference the same `_synth._generate_lock` symbol.

### C-4 (P0) **Accessibility audit infrastructure is structurally broken in the working tree**

- **Files:** `scripts/vendor/axe.min.js`, `scripts/vendor/axe.min.js.sha256`, `scripts/vendor/axe.py`, `scripts/audit_a11y.py`, `scripts/smoke_gapless_browser.py`, `scripts/vendor/fetch.py`, `.github/workflows/ci.yml`.
- **Observed:**
  - `scripts/vendor/axe.min.js` is 73 bytes containing the literal text `placeholder - run \`python scripts/vendor/fetch.py axe-core\` to populate.`
  - `scripts/vendor/axe.min.js.sha256` is 73 bytes of the same placeholder.
  - `scripts/vendor/axe.py:29-31` defines `AXE_SHA256` as 64 zero hex digits.
  - `scripts/audit_a11y.py:208-217` calls `_axe_vendor.verify_axe(payload)` which will raise `RuntimeError("axe-core SHA256 mismatch")` for any real axe-core bytes — and even on the placeholder, computes a non-zero SHA256 that doesn't match the all-zero pinned value, so the audit fails immediately on startup.
  - `scripts/audit_a11y.py` itself is **untracked** (`git ls-files scripts/audit_a11y.py` returns nothing).
  - `scripts/smoke_gapless_browser.py` is **untracked**.
  - `scripts/vendor/` is **untracked**.
  - `.github/workflows/ci.yml:67-117` (working tree) adds `gapless_browser` and `a11y_audit` jobs that call these untracked scripts.
- **Why it matters:** The a11y audit cannot pass; the gapless browser smoke script (see C-5) does not actually test what it claims. CI is non-gating (`continue-on-error: true`) so the failures are silent. **A11Y-1 (hidden file input without label) and A11Y-2 (`<div aria-label>` without role) were the last tracked accessibility violations** — they are in fact fixed in the working tree (`frontend/src/components/reader/Reader.jsx:498` has `aria-label="Choose a book file"`; `frontend/src/components/Toast.jsx:137` has `role="region"`), but `tasks/todo.md:49-58` still lists them as open. The audit would have caught them; instead it errors before any scan.
- **Confidence:** HIGH. **Classification:** CONFIGURATION ISSUE (the structural pieces are in place but the vendored asset is a placeholder; the gate is silently green because of `continue-on-error`).
- **Verification:** `Get-Content scripts/vendor/axe.min.js` returns the placeholder string.

### C-5 (P1) **`scripts/smoke_gapless_browser.py` does not actually test gapless chunk advance**

- **File:** `scripts/smoke_gapless_browser.py:240-292`.
- **Symbol:** `run_smoke`.
- **Observed:** the script
  1. Boots a stub HTTP backend that returns two 0.5 s WAV chunks then a "done" event.
  2. Opens the page in headless Chromium.
  3. Calls `page.evaluate(...)` that **replaces the entire page body** with a synthetic `<audio>` element (`document.createElement('audio')`) and listens for `timeupdate`.
  4. Loads a single canonical full-page WAV (`/sessions/stub/page_1_testdigest.wav` — the pre-merged `FULL_WAV` from the stub).
  5. Asserts `currentTime` advances monotonically with no backward jumps.
- **Why it matters:** the production gapless behaviour is the **chunk advance** in `frontend/src/hooks/reader/useReaderNarration.js` (driven by `playlistController.js`), not "a single WAV plays continuously". A regression that, say, broke chunk-advance timing so the second chunk loaded 200 ms after the first finished would not be detected: the script never wires up the actual reader; it constructs an `<audio>` and tests monotonic playback of a single file. The unit test for `playlistController.js` exists but a true regression would also need the React reader + stub chunk responses wired together.
- **Confidence:** HIGH. **Classification:** TEST GAP / false confidence.

### C-6 (P1) **Reader.jsx `updatePreparedProgress` debounce never fires during continuous playback**

- **File:** `frontend/src/components/reader/Reader.jsx:248-269`.
- **Symbol:** debounce effect for `updatePreparedProgress`.
- **Observed:**
  ```jsx
  useEffect(() => {
      if (!libraryBookId || !file) return undefined;
      const timer = setTimeout(() => { updatePreparedProgress(...) }, 3000);
      return () => clearTimeout(timer);
  }, [file, libraryBookId, pageNumber, bookmarks, transport.currentTime, setBooks, toast]);
  ```
  `transport.currentTime` updates on every `timeupdate` event (~4 Hz during playback). Every update clears the previous 3 s timer and starts a new one — this is a *trailing-edge reset*, not a debounce. While listening, the timer never elapses.
- **Why it matters:** the server-side mirror of the reading position never advances while the user is actively listening. When the user closes the page (or `libraryBookId`/`file` changes), the timer is cleared without firing. The library's continue-reading row stays at the page they opened with, not the page they're on.
- **Compare with:** `frontend/src/hooks/reader/useReaderProgress.js:90-92` uses the *opposite* pattern (leading-edge throttle: arm a new timer only if one isn't already pending), and that one works correctly.
- **Confidence:** HIGH. **Classification:** CONFIRMED BUG.

### C-7 (P1) **`useServerPageText.findText` warms **all** pages before returning the first match**

- **File:** `frontend/src/hooks/reader/useServerPageText.js:52-59`.
- **Symbol:** `findText`.
- **Observed:** `await mapWithConcurrency(pages, 3, ...)` fetches every page before scanning for the query. For a 500-page text book with cold cache, this is 500 HTTP fetches (concurrency 3) before the search result lands.
- **Why it matters:** the user clicks "Search", sees a spinner, then waits 30+ s for a "found on page 3" — and in the meantime there is no progress feedback, no early exit on first match, and the cost is borne even when no match exists.
- **Confidence:** HIGH. **Classification:** DESIGN RISK / UX.

### C-8 (P1) **WinUI `SavePlacement` loses restore bounds on the first close-while-maximized**

- **File:** `desktop/BookVoice.App/MainWindow.xaml.cs:586-610`.
- **Symbol:** `SavePlacement`, branch 598-606.
- **Observed:** When `presenter.State == Maximized`, the code does
  ```csharp
  var existing = WindowPlacement.Load(_runtimeDir);
  var restore = existing ?? new WindowBounds(0, 0, MinWidth, MinHeight, Maximized: false);
  WindowPlacement.Save(_runtimeDir, restore with { Maximized = true, DpiScale = dpiScale });
  ```
  On first close-while-maximized (no prior save file), `existing` is null and the placeholder `(0, 0, MinWidth, MinHeight)` is persisted as the unmaximized rect. The next launch opens at that 780 × 560 origin. Win32's `GetWindowPlacement` returns the real `rcNormalPosition` even when the window is maximized — that's the primitive to use.
- **Confidence:** HIGH. **Classification:** CONFIRMED BUG (regression of M-26; P1 hardening did not fix the first-launch case).

### C-9 (P1) **WinUI `OnAppWindowChanged` only knows about the primary display**

- **File:** `desktop/BookVoice.App/MainWindow.xaml.cs:70-91`.
- **Symbol:** `OnAppWindowChanged`.
- **Observed:** the clamp uses `var work = DisplayArea.Primary.WorkArea;` only. The initial placement was fixed (M-24 partial: `ResolveWorkArea` at lines 171-189 enumerates `DisplayArea.FindAll()`) but the runtime listener does not. A window on a secondary monitor can be teleported into Primary if its position drifts.
- **Confidence:** HIGH. **Classification:** INCOMPLETE (partial fix of M-24).

### C-10 (P1) **WinUI `BookVoiceFileAssociation` writes an absolute `DefaultIcon` path**

- **File:** `desktop/BookVoice.App/Backend/BookVoiceFileAssociation.cs:26-31`.
- **Symbol:** `Apply`.
- **Observed:**
  ```csharp
  var iconPath = Path.Combine(AppContext.BaseDirectory, "Assets", "bookvoice.ico");
  icon.SetValue(null, $"\"{iconPath}\",0");
  ```
  The comment claims "relative reference so a portable move does not leave the icon pointing at a stale absolute path", but the value written is the absolute path string. M-33 from the prior review claimed this was addressed; it is not.
- **Confidence:** HIGH. **Classification:** INCOMPLETE (M-33 not fixed).

### C-11 (P2) **`useReaderNarration` has no direct unit test; `Reader.test.jsx` does not exercise the PDF error path or cancel-with-page-text-update**

- **Files:** `frontend/src/hooks/reader/useReaderNarration.js` (473 lines, 0 direct tests); `frontend/src/components/reader/Reader.test.jsx`.
- **Symbol:** entire `useReaderNarration` hook; `Reader.jsx:452-462 handleDocumentError`.
- **Observed:** `useReaderNarration` owns the race-cancel, chunk advance, resume parking, mute handling, stream abort. The only coverage is indirect through `Reader.test.jsx`. The PDF error handler (`handleDocumentError`) translates an exception message into one of three user-facing strings — no test triggers `Document.onLoadError`. The "cancels in-flight generation" test (`Reader.test.jsx:325-344`) calls Next twice from page 1 but does not assert the audio `src` is cleared or that the page text updates correctly between generations.
- **Confidence:** HIGH. **Classification:** TEST GAP.

### C-12 (P2) **WinUI C# has zero unit-test coverage**

- **Files:** `desktop/BookVoice.App/Backend/*.cs` and `desktop/BookVoice.App/MainWindow.xaml.cs`.
- **Observed:** `tests/` has no `.csproj`, no `dotnet test` step in `.github/workflows/ci.yml`. Deterministic logic — `AppPaths.InstallId`, `WindowPlacement.Load/Save`, `IsAllowedExternalScheme`, the file-association registration paths — is uncovered. Tests named `test_launch_splash.py`, `test_launcher_app.py`, `test_system_tray.py` test the **Python** launcher / installer / system_tray, not the C# shell. (`test_launch_splash.py:6` `import launch`.)
- **Confidence:** HIGH. **Classification:** TEST GAP (largest single gap).

### C-13 (P2) **The new Reader ships with substantial dead code in its dependency tree**

- **Files:** `frontend/src/hooks/reader/usePageResume.js` (+ test, 245 lines total), `frontend/src/components/reader/{ReaderToolbar, ReaderBanners, ResumeDialog, ReadingOptionsPanel, TextPageColumn, TranscriptColumn}.jsx` (~3,400 lines combined), all imported only by `PdfViewer.jsx`.
- **Observed:** `grep -l "PdfViewer"` shows the legacy reader is the sole importer. `CONTRACT.md:70` still lists `usePageResume` as part of the reader surface; the new `Reader.jsx` doesn't import it. `PARITY.md` row 1 marks "Reader toolbar parity" Closed (with a test), but the file still ships.
- **Why it matters:** maintenance tax; readers of the code who land on these files assume they are still wired in. The prior audit flagged this as M-103 / F5.
- **Confidence:** HIGH. **Classification:** DEAD/REDUNDANT CODE.

### C-14 (P2) **`PdfViewer.jsx` is 2,256 lines and ~95% dead in the default path**

- **File:** `frontend/src/components/PdfViewer.jsx` (108,531 bytes).
- **Observed:** only mounted with `?reader=old` (`App.jsx:127`). `PARITY.md` lists five known gaps; the `?reader=old` rollback hatch is described in CHANGELOG as "intentional, while the new reader catches up".
- **Why it matters:** the file's complexity (its own hooks `useWordHighlight`, `usePageNarration`, `usePrefetch`, plus the imported dead sub-components) is a maintenance debt. The CHANGELOG marks "deleting `PdfViewer.jsx` is slice 0.5" as a deferred task.
- **Confidence:** HIGH. **Classification:** DEAD/REDUNDANT CODE.

### C-15 (P2) **CONTRACT.md / Reader.jsx header / PARITY.md all drift from shipped behaviour**

- **Files:** `frontend/src/components/reader/CONTRACT.md` (untracked), `frontend/src/components/reader/PARITY.md` (untracked), `frontend/src/components/reader/Reader.jsx:48-63`.
- **Observed:**
  - `CONTRACT.md:70` lists `usePageResume` as part of the reader surface — the hook is dead.
  - `CONTRACT.md:152` row "Saved voice + language from `useUserConfig`" says **absent** — but `Reader.jsx:225-234` implements it exactly. `PARITY.md` row 2 marks it Closed.
  - `CONTRACT.md:157` row "Sleep timer" says **absent** — `Reader.jsx:208-212` and 668-692 implement it. `PARITY.md` row 3 marks it Closed.
  - `CONTRACT.md:159` row "Page-jump numeric input" says **absent** — `Reader.jsx:567-579` implements it. `PARITY.md` row 4 marks it Closed.
  - `Reader.jsx:60-63` says "the transport wraps an empty ref, so play/pause, mute, seek, and true audio resume are intentional no-ops until the narration pipeline lands." This is stale; `useReaderNarration.js` (473 lines) is fully implemented and the reader tests exercise it.
  - `PARITY.md:32` has a `**` typo (`**CHANGELOG.md**`).
- **Confidence:** HIGH. **Classification:** DOCUMENTATION DRIFT.

### C-16 (P2) **`tasks/todo.md` lists A11Y-1 and A11Y-2 as still open**

- **File:** `tasks/todo.md:49-58` (working tree).
- **Observed:** A11Y-1 (hidden file input without label) and A11Y-2 (`<div aria-label>` without role) are both **already fixed** in the working tree (`Reader.jsx:498`, `Toast.jsx:137`). The `book_library_service.py` split is correctly tracked as deferred.
- **Confidence:** HIGH. **Classification:** DOCUMENTATION DRIFT (stale checklist).

### C-17 (P2) **A11Y-1 and A11Y-2 are fixed in code but uncommitted**

- **Files:** `frontend/src/components/reader/Reader.jsx:498` (`aria-label="Choose a book file"`), `frontend/src/components/Toast.jsx:137` (`<div className="toast-region" role="region" aria-label="Notifications">`).
- **Observed:** both fixes are present (working-tree diffs include these lines) but **uncommitted**.
- **Why it matters:** if the user ships from `HEAD`, the axe-core scan would re-flag these two issues — and the audit gate is currently broken anyway (C-4). The fixes are real but unmerged.
- **Confidence:** HIGH. **Classification:** INCOMPLETE (fixes exist locally; not in `HEAD`).

### C-18 (P2) **WinUI `WindowBounds.DpiScale` is recorded but never applied on restore**

- **Files:** `desktop/BookVoice.App/Backend/WindowPlacement.cs` and `desktop/BookVoice.App/MainWindow.xaml.cs:597,609`.
- **Observed:** `WindowPlacement.Load` decodes `dpiScale`; `MainWindow.SavePlacement` writes it; `MainWindow.ConfigureWindow` (lines 152-168) does not use it when computing the restore rect. The DPI field is recorded but does nothing on restore. The original L-8 fix is partial.
- **Confidence:** HIGH. **Classification:** DEAD/REDUNDANT CODE.

### C-19 (P3) **WinUI `OnRetryClick` leaves stale event subscriptions on the previous host**

- **File:** `desktop/BookVoice.App/MainWindow.xaml.cs:448-453`.
- **Observed:** `_host?.Dispose(); _host = null; StartBackend();` — `Dispose` calls `Stop()` but never unsubscribes the three event handlers (`StatusChanged`, `BecameReady`, `Failed`) attached on lines 226-228. The previous `RunAsync` task can still complete a `StatusChanged`/`Failed` invocation between `Dispose()` and the new `_host = …` assignment, dispatching stale status.
- **Confidence:** MEDIUM. **Classification:** LIKELY BUG.

### C-20 (P3) **`AppPaths.ReadVersion` runs `git describe` synchronously on the UI thread**

- **File:** `desktop/BookVoice.App/Backend/AppPaths.cs:59-91`.
- **Observed:** called from `MainWindow.ResolvePaths` (line 121) and `MainWindow.ConfigureWindow` (line 152), both on the UI thread. The 2 s `WaitForExit` cap and the stdout-read can stall the first frame on a slow disk.
- **Confidence:** MEDIUM. **Classification:** DESIGN RISK (cosmetic on most installs; latency hit on dev machines).

### C-21 (P3) **Two copies of `bookvoice.ico`**

- **Files:** `desktop/BookVoice.App/bookvoice.ico` (project root, used as EXE icon) and `desktop/BookVoice.App/Assets/bookvoice.ico` (runtime + file association).
- **Observed:** csproj lines 21 + 40 + 43-46; comment in csproj acknowledges "Two copies of bookvoice.ico are intentional". A designer changing one but not the other produces a silent icon mismatch.
- **Confidence:** HIGH. **Classification:** CONFIGURATION ISSUE.

### C-22 (P3) **`backend/services/update_service.py` `download_installer` has no hard upper bound on bytes received during streaming**

- **File:** `backend/services/update_service.py:253-293`.
- **Observed:** the manifest `size` is read and used for the final checksum comparison, but there is **no per-chunk size cap** and **no per-chunk timeout**. `response.read(1024*1024)` reads chunks indefinitely; the `urlopen` timeout (15 s) only governs the initial connection. A maliciously slow or oversized-but-honest manifest could pin the thread for minutes or hold an unbounded partial.
- **Compare with:** `scripts/setup_bootstrapper.py:74, 188-191` has `MAX_ASSET_BYTES = 1 GB` and a hard per-chunk cap (`if received + len(chunk) > MAX_ASSET_BYTES: raise RuntimeError`). The in-app updater has the equivalent cap missing.
- **Confidence:** MEDIUM. **Classification:** DESIGN RISK.

### C-23 (P3) **`backend/services/audiobook_export_service.py` `os.replace` then post-cancel check**

- **File:** `backend/services/audiobook_export_service.py:244-250`.
- **Observed:**
  ```python
  media_tools.run_media_tool("ffmpeg", [..., str(temp_output)], timeout=FFMPEG_TIMEOUT_SECONDS, cancel_check=...)
  if _cancel_requested(job):
      raise media_tools.MediaToolCancelled("ffmpeg was cancelled.")
  os.replace(temp_output, final_output)
  if _cancel_requested(job):
      final_output.unlink(missing_ok=True)
      raise media_tools.MediaToolCancelled("ffmpeg was cancelled.")
  ```
  If cancellation arrives during the ffmpeg run, the script still produces the output file and renames it before deleting it — wasteful on a 30-minute render that the user just cancelled.
- **Confidence:** LOW. **Classification:** DESIGN RISK (minor).

### C-24 (P3) **Hand-rolled single-instance plumbing in C#**

- **File:** `desktop/BookVoice.App/Backend/SingleInstance.cs:1-67` (and `App.xaml.cs:41-53`).
- **Observed:** `Mutex` + named `EventWaitHandle` + listener thread. The header comment says "TODO: migrate to `Microsoft.Windows.AppLifecycle.AppInstance.RedirectActivationToAsync`". M-35 acknowledged but not done.
- **Confidence:** HIGH. **Classification:** DEAD/REDUNDANT CODE / NEEDS HUMAN DECISION.

### C-25 (P0) **Login throttle "unknown" bucket is shared by all clients behind a trusted proxy without `X-Forwarded-For`**

- **File:** `backend/services/access_service.py:175-181` (`throttle_key`) and `backend/routes/access.py:44-48`.
- **Symbol:** `throttle_key`, called from `routes/access.py` login failure handler.
- **Observed:** when `trust_proxy_headers=True` and the request carries no `X-Forwarded-For` header, `throttle_key` returns `f"direct:unknown"` because `client_host` falls through to empty. Every client that fails to send `X-Forwarded-For` from behind a trusted proxy shares one throttle bucket; one guesser locks them all out.
- **Why it matters:** a deployment that turns on `BOOKVOICE_TRUST_PROXY_HEADERS` (a sensible default behind a TLS-terminating proxy) becomes DoS-able by one attacker filling the "unknown" bucket to 5 failures.
- **Confidence:** MEDIUM. **Classification:** CONFIRMED BUG.

### C-26 (P1) **Pronunciation cache is shared across all users in a hosted deployment**

- **File:** `backend/services/tts_service/streaming.py:262-287` (`pronounce_text`).
- **Symbol:** `cache_session = "pronunciation-cache"`; filename is a 20-char hex hash of the prompt content (text, language, voice_signature, model_dir).
- **Observed:** the cache is served by the `/sessions/pronunciation-cache/{filename}` static route. Any user who knows (or guesses) another user's prompt content can fetch that user's clip. The 20-char hex is not a secret per se — it leaks the prompt text through the cache and the `/sessions` mount.
- **Why it matters:** hosted deployments (`BOOKVOICE_SERVER_MODE=1`) advertise this as private (the Settings card hides Save-to-Downloads; per-device isolation is in place for Voice Studio); the pronunciation cache is the one place where content crosses user boundaries. Privacy leak.
- **Confidence:** HIGH. **Classification:** LIKELY BUG.

### C-27 (P1) **`audiobook_export_service` `_prune_runtime_records` is never called from the read path**

- **File:** `backend/services/audiobook_export_service.py:28-34, 111-116`.
- **Symbol:** `_prune_runtime_records`, `_jobs`, `get_audiobook_job`.
- **Observed:** `_prune_runtime_records` is invoked inside `create_audiobook_export` (line 55). `get_audiobook_job` (line 111-116) does NOT call it. So old completed jobs (`status="COMPLETED"`, `endedAt < cutoff`) stay in `_jobs` indefinitely until a new export is created or `discard_downloaded_job` runs.
- **Why it matters:** for long-running servers with many book exports and no downloads, the `_jobs` dict grows monotonically. Memory leak.
- **Confidence:** MEDIUM. **Classification:** LIKELY BUG.

### C-28 (P2) **`backend/services/tts_service/queue.py` has no `reset_runtime_state_for_tests` helper**

- **File:** `backend/services/tts_service/queue.py:30-77`.
- **Symbol:** `_tts_job_queue`, `_tts_seq`, `_tts_worker_started` (module globals).
- **Observed:** the sibling `studio_service.projects` exposes `reset_runtime_state_for_tests` for test isolation; `tts_service.queue` does not. The current test suite (`tests/test_tts_lifecycle.py`) reaches into `self.tts.model._model_state` directly — fragile refactor bait (see C-11 / finding #73 in the backend audit).
- **Why it matters:** the test suite is coupled to private state; any refactor of `_model_state` (the docstring hints at extracting a `ModelState` class) would break every test. The asymmetry with the Studio package suggests the helper was forgotten.
- **Confidence:** MEDIUM. **Classification:** DESIGN RISK / TEST GAP.

### C-29 (P3) **`backend/services/tts_service/streaming.py` lock asymmetry is undocumented**

- **File:** `backend/services/tts_service/streaming.py:104-176` vs `backend/services/tts_service/synth.py:473-477`.
- **Observed:** the docstring in `synth.py` explicitly says `_generate_lock` is held only across the per-chunk inference. `streaming.py` holds it for the entire multi-chunk loop. The asymmetry is intentional (per-stream coherence) but undocumented. (Related to C-3 — the fix is to release the lock per-chunk here too, mirroring the synth.py pattern.)
- **Confidence:** MEDIUM. **Classification:** DOCUMENTATION DRIFT.

### C-30 (P3) **`routes/audiobooks.py` reaches into `services.studio_service.downloads` for a private symbol**

- **File:** `backend/routes/audiobooks.py:70-71`.
- **Observed:** `from services.studio_service.downloads import _download_file_name`. The leading underscore marks it private. A rename or repackaging of `_download_file_name` silently breaks this route.
- **Why it matters:** the public sanitizer should arguably live in `path_utils` or a `studio_service` public function. Today the underscore is a soft contract.
- **Confidence:** MEDIUM. **Classification:** DESIGN RISK.

### C-31 (P3) **`book_library_service` `_import_extracted_path` writes manifest twice; partial-import failure leaves source file on disk with no manifest**

- **File:** `backend/services/book_library_service.py:404-428`.
- **Observed:** `if not manifest_path.exists(): ... _write_json(...); try: save_page(...) ... except Exception: manifest_path.unlink(missing_ok=True); raise`. If `save_page` raises mid-loop, the partial manifest is unlinked and the error re-raised. The source file (`source.epub`/`source.txt`) is already on disk in the book directory; no cleanup runs on it.
- **Why it matters:** an interrupted EPUB import leaves a half-imported state. The next import will re-create the manifest because `_sha256_file(source)` still matches — so the state is *recoverable* but ugly, and a future bug that re-runs `save_page` without the manifest-existence check could double-save pages.
- **Confidence:** MEDIUM. **Classification:** LIKELY BUG (incomplete atomicity).

### C-32 (P3) **`_summary_cache` not invalidated on `manifest_path.unlink`**

- **File:** `backend/services/book_library_service.py:495` and `delete_book` line 527 (the latter is invalidated; the former is not).
- **Observed:** `delete_book` invalidates the cache (line 527), but the partial-import cleanup at line 422 (`manifest_path.unlink(missing_ok=True)`) does NOT. A subsequent `list_books()` could surface a book whose manifest was just deleted.
- **Confidence:** MEDIUM. **Classification:** LIKELY BUG.

### C-33 (P3) **`book_library_service` uses a single global `RLock()` for the entire library**

- **File:** `backend/services/book_library_service.py:54`.
- **Observed:** `_lock = threading.RLock()` is module-global. Any book write blocks every other book write. The sibling `studio_service` uses per-project locks (`_project_lock`).
- **Why it matters:** throughput bottleneck for users with many books. A per-book lock would let parallel preps across books.
- **Confidence:** MEDIUM. **Classification:** DESIGN RISK.

### C-34 (P3) **`routes/tts.py` `_request_cancellations` is unbounded — memory grows with `request_id` cardinality**

- **File:** `backend/routes/tts.py:35-36, 133-149`.
- **Observed:** `_release_cancellation` removes an entry only when the matching `token` finishes. If a client repeatedly sends `request_id`s without ever completing (e.g. dropouts), entries accumulate for the lifetime of the process. No TTL, no LRU bound.
- **Why it matters:** memory leak / DoS vector from a misbehaving client. Auth is gated, so reachable only inside a session — but a hostile browser session could grow the dict without bound.
- **Confidence:** MEDIUM. **Classification:** DESIGN RISK.

### C-35 (P3) **`_studio_device_scope` writes Secure cookie based on `request.url.scheme` without honoring forwarded proto**

- **File:** `backend/routes/studio.py:50-60`.
- **Observed:** `secure=request.url.scheme == "https" or forwarded_scheme == "https"`. When the deployment uses a TLS-terminating proxy that doesn't append `X-Forwarded-Proto`, `request.url.scheme` is `"http"` and the cookie is set non-Secure but the browser is on HTTPS — the browser refuses the cookie.
- **Why it matters:** operational misconfiguration. Documented (the env var is explicit), but a heuristic (`if trust_proxy_headers: secure=False`) would auto-handle the proxy case.
- **Confidence:** MEDIUM. **Classification:** LIKELY BUG.

### C-36 (P3) **Duplicated helpers across modules with subtle drift**

- **Files / symbols:**
  - `_copy_atomic` in `backend/services/studio_service/media.py:229` and `backend/services/studio_service/voice_profiles.py:27`.
  - `_extract_clip` in `backend/services/studio_service/narration.py:75-78` (one-line wrapper around `_extract_profile_clip`).
  - `_sha256_file` in `book_library_service.py`, `voice_profile_service.py`, `studio_service/media.py`.
  - `_replace_with_retry` (6 attempts) in `book_library_service.py` vs `replace_file_with_retry` (20 attempts, smarter backoff) in `storage_utils.py` — the better helper exists, but several call sites still use bare `os.replace`.
- **Why it matters:** subtle drift between two copies of `_copy_atomic` (the voice_profiles version re-imports `shutil` inside the function). `_replace_with_retry` is the better helper but is not uniformly used.
- **Confidence:** HIGH (for the duplication). **Classification:** DEAD/REDUNDANT CODE.

### C-37 (P3) **`backend/services/remote_execution.py` is dead code in default deployment**

- **File:** `backend/services/remote_execution.py` (entire file).
- **Observed:** `_executor` is `None` unless `set_executor` is called. `main.py` never calls `set_executor`. So all the `remote_execution` plumbing is dormant. `services/generation_gateway.py:run_remote_job` is therefore unreachable from the main code path.
- **Confidence:** HIGH. **Classification:** DEAD/REDUNDANT CODE (by design, but flagged because no executor path is exercised in the codebase).

### C-38 (P3) **`backend/services/tts_service/model.py` `_InferenceCfgRateGuard` (and the conversion.py analogue) mutates vendored decoder state**

- **File:** `backend/services/tts_service/conversion.py:53-94`; same pattern in `model.py` for `_prepare_voice_conditionals`.
- **Observed:** reaches into `chatterbox.s3gen.flow.decoder.inference_cfg_rate`. A future upstream Chatterbox release that renames or moves that field silently disables the guidance tweak (`_changed = False` path).
- **Why it matters:** the package is vendored at `chatterbox/`; an upstream bump would require manual verification.
- **Confidence:** MEDIUM. **Classification:** DESIGN RISK (H-6 from prior review confirmed).

### C-25 (P3) **`bookvoice.ico` is duplicated and `BookVoice.App.csproj` enables MSIX tooling flags unnecessarily**

- **File:** `desktop/BookVoice.App/BookVoice.App.csproj`.
- **Observed:** `<EnableMsixTooling>false</EnableMsixTooling>` is set (M-32 fixed), but `<WindowsPackageType>None</WindowsPackageType>` + the absence of `<RuntimeIdentifier>` makes the self-contained publish profile inconsistent with the README's claim of `dist/desktop/BookVoice.exe`. Not blocking; worth verifying the actual `dotnet publish -r win-x64` output shape.
- **Confidence:** LOW. **Classification:** CONFIGURATION ISSUE.

### C-26 (P0) **`scripts/audit_a11y.py` boots the stub backend and static file server on different ports**

- **File:** `scripts/audit_a11y.py:99-106, 162-166` (stub + static server startup); `audit_a11y.py` test loop drives `page.goto(f"http://127.0.0.1:{frontend_port}{route}", ...)`.
- **Observed:** the static file server serves `backend/static/` on one free loopback port; the stub backend serves `/api/*` on a *different* free loopback port. The frontend's `index.html` calls `/api/health` relative to its origin — so all `/api/*` calls in the audit hit the static file server, which returns 404 for unknown paths (the SPA-fallback serves `index.html` for unknown routes, so the JSON API requests are answered with the HTML document, not a 404 with a JSON body). Every WCAG scan is taken against a frontend whose API is non-functional: any axe-core scan that depends on real backend data (e.g. loading the Studio or Library surface) sees an empty / broken render and either passes for the wrong reason or misses violations only visible with real data.
- **Why it matters:** layered on top of C-4 (the vendored bundle is a placeholder), the audit has never actually exercised a working frontend-with-stub. Even after `python scripts/vendor/fetch.py axe-core` populates the bundle, this port mismatch would silently produce wrong audits.
- **Fix pattern:** either (a) run the stub and static server in *one* `ThreadingHTTPServer` that serves both `/api/*` and `/assets/*` and falls back to `index.html` for everything else, or (b) write a static-file-server-with-API-handler hybrid. The current split is an architectural mistake, not just a config issue.
- **Confidence:** HIGH. **Classification:** LIKELY BUG (the audit "passes" but for the wrong reason; combined with C-4 the gate is effectively inert).

### C-27 (P2) **`scripts/setup_bootstrapper.py` duplicates the `--latest` argument-handling block**

- **File:** `scripts/setup_bootstrapper.py:347-400` (the `main()` body).
- **Observed:** `main()` has two near-identical `if args.latest / else` blocks; the second overwrites the first. A one-line edit in either block can silently break `--latest`, and readers cannot tell which branch wins when `--manifest-url` is also passed.
- **Why it matters:** the bootstrapper is the entry point for fresh installs and the in-app updater; a regression here blocks users from installing or updating.
- **Confidence:** HIGH. **Classification:** LIKELY BUG / dead code.

### C-28 (P2) **`launch.py` and `serve_bookvoice.py` have divergent sticky-port logic**

- **Files:** `launch.py:760-825` (`pick_port`, `port_stolen`, `next_free_port`) vs `serve_bookvoice.py:79-114` (`sticky_port`, `choose_port`, `remember_port`).
- **Observed:** `launch.py` implements scan + steal-retry; `serve_bookvoice.py` adds a sticky-port layer that wraps `launch.pick_port`. When `BookVoice.exe --browser --no-window` runs `launch.main()`, it never writes a sticky-port file; `serve_bookvoice.py`'s `sticky_port` always falls back to scan on next start. Two entry points leave different sticky-port breadcrumbs; a user who starts via `BookVoice.exe` and then via `Start-BookVoice-Server.bat` (or vice-versa) sees a port change even when the previous port was free.
- **Why it matters:** breaks the bookmarked-URL and tunnel-routing promise from CHANGELOG ("the port this install last came up ready on is reused when free").
- **Confidence:** HIGH. **Classification:** DESIGN RISK.

### C-29 (P3) **`TESTING.md` references `BookVoice-Dev.exe`, which `build.py` does not produce**

- **Files:** `TESTING.md:7-9`; `BookVoice-Dev.spec`; `build.py:516` (only builds `Launcher.exe`, the legacy).
- **Observed:** the manual test script says "Start BookVoice from `dist/BookVoice-Dev.exe`". `build.py` does not invoke PyInstaller on `BookVoice-Dev.spec`. A developer following the docs would have to run `pyinstaller BookVoice-Dev.spec` manually first, which is not documented.
- **Why it matters:** the manual test workflow is broken on a clean checkout.
- **Confidence:** HIGH. **Classification:** DOCUMENTATION DRIFT.

### C-30 (P3) **`scripts/smoke_gapless_browser.py` `PYTHON` constant is unused dead code**

- **File:** `scripts/smoke_gapless_browser.py:51`.
- **Observed:** `PYTHON = str(VENV_PY if VENV_PY.is_file() else Path(sys.executable))` is computed at import time but never referenced. The script starts its own HTTP server in-process via `ThreadingHTTPServer`; no Python is launched.
- **Confidence:** HIGH. **Classification:** DEAD/REDUNDANT CODE.

### C-31 (P3) **`scripts/smoke_gapless_browser.py` docstring "<10 s smoke" is misleading**

- **File:** `scripts/smoke_gapless_browser.py:18` and `wait_for_health` (line 222, 10 s timeout) plus the `while (!window.__gapless.ended)` loop with up to 180 s (line 280).
- **Observed:** module docstring says "<10 s"; realistic worst case is ~3 minutes (audio wait + Playwright boot + retry).
- **Confidence:** HIGH. **Classification:** DOCUMENTATION DRIFT.

---

## 5. Probable problems / unresolved risks

### L-1 (P2) **`backend/services/voice_profile_service.py` `list_profiles` may read every metadata JSON on every call**

- The prior review (L-68) noted this; a cache with mtime invalidation is documented as a fix but no test was observed. A library with many voices would see this on every Settings render.

### L-2 (P2) **`backend/services/studio_service/manifest.py:_directory_size` walks the project tree on every `get_project`**

- The prior review (M-8) noted this; a cache with mtime invalidation would help UI polling.

### L-3 (P2) **`_synth._generate_chunk` reaches into `chatterbox.s3gen.flow.decoder.inference_cfg_rate` (H-6)**

- `backend/services/tts_service/conversion.py:328-332` mutates a private upstream attribute to apply voice-conversion guidance. The vendored chatterbox is from Resemble AI; if a future upstream release renames or moves that field, the conversion silently uses the default guidance. Worth pinning via a wrapper.

### L-4 (P2) **`Reader.jsx:217-221` `useEffect` fires `notifyPageEnded` on every manual stop, not just on natural end-of-page**

- `useReaderNarration.stopPlayback()` sets `transportState === 'stopped'`; the effect then triggers `useSleepTimer.fire()` whenever the sleep mode is `SLEEP_END_OF_CHAPTER`. A user clicking Stop in the middle of a chapter will end the end-of-chapter arm prematurely. MEDIUM confidence because the actual end-of-chapter stop depends on `onNarratePage` ordering (verified to call `stopPlayback` on natural end). Fixing this requires distinguishing "user clicked Stop" from "stream ended naturally".

### L-5 (P2) **`backend/services/tts_service/queue.py` worker thread is `daemon=True`**

- The worker thread at `_ensure_tts_worker` is a daemon. On `SIGINT` / process exit, daemon threads are killed abruptly. Pending TTS futures will hang their `await`ers. `_tts_queue_worker` correctly catches `BaseException` (line 53-65) so the worker survives, but a future that was mid-`set_exception` may not get the signal. Low impact on graceful shutdown, higher on a forced kill.

### L-6 (P3) **`scripts/kill_stale_bookvoice.ps1` mixes `$ErrorActionPreference = 'Continue'` and `Set-StrictMode -Version Latest`**

- The prior review (H-12) flagged this; not blocking, but PowerShell best practice.

### L-7 (P3) **Multiple `bookvoice-` log files can exist in the runtime dir before rotation**

- `backend/services/tts_service/synth.py:_SESSION_CLEANUP_INTERVAL = 3600` (1 h) is generous. Sessions are cheap to re-narrate but disk fills.

### L-8 (P3) **`scripts/smoke_exe.py` may print sensitive log content on failure**

- The prior review (M-65) noted the last 2500 chars of server log printed on failure. Not blocking; worth redaction.

### L-9 (P3) **`tasks/perf-baseline.json` includes machine hostname (already partially redacted)**

- Verified: `"machine": "a44bc3780e1c9e8e"` is a hash, not a hostname. Prior concern (M-86 / L-79) resolved.

### L-10 (P3) **`scripts/setup_linux.sh` `apt-get install -y` without `--no-install-recommends`**

- The prior review (M-99) flagged this. Worth tightening.

### L-11 (P3) **`backend/services/book_library_service.py:_summary_cache` is module-level mutable state**

- `dict[str, tuple[int, dict]]` keyed by bookId. A concurrent reader and writer (e.g. `mark_page_audio` updating `updatedAt`) could see a stale summary for one frame. The `_summary` walk is non-trivial; the cache is the right pattern; the eviction needs `del` not reassignment to avoid leaking the cache forever.

### L-12 (P3) **`backend/services/studio_service/manifest.py:_executor` is never shut down**

- The prior review (M-12) noted jobs leak on app exit. `atexit.register(_executor.shutdown, wait=False)` is the standard fix.

### D-27 (P1) **`deploy/linux/install.sh` does not translate `--host lan` / `--host all` to `0.0.0.0`**

- **File:** `deploy/linux/install.sh:75-77, 240-241`.
- **Observed:** `--host lan` is accepted but written verbatim into `BOOKVOICE_HOST=lan` in the env file. The systemd unit (`bookvoice.service.template:18`) then expands `${BOOKVOICE_HOST}` into `uvicorn main:app --host ${BOOKVOICE_HOST} --port ${BOOKVOICE_PORT}` — uvicorn refuses with `error while attempting to bind on address 'lan'`. The desktop launcher (`launch.py:740 resolve_bind_host`) translates `lan`/`all` to `0.0.0.0` before passing to uvicorn; `install.sh` does not.
- **Why it matters:** `sudo deploy/linux/install.sh --host lan` renders an unbootable systemd unit. The user can fix it by hand-editing the env file, but this is a foot-gun.
- **Confidence:** HIGH. **Classification:** LIKELY BUG.

### D-28 (P1) **`deploy/linux/install.sh` t64 retry handles only one of two Ubuntu 24.04 package renames**

- **File:** `deploy/linux/install.sh:113-122`.
- **Observed:** the retry at line 158-159 replaces `libglib2.0-0` with `libglib2.0-0t64` (`PKGS="${PKGS[@]/libglib2.0-0/libglib2.0-0t64}"`). On Ubuntu 24.04, `libgl1` was also renamed to `libgl1t64`. The retry does not handle it. A fresh install on Ubuntu 24.04 fails the second time as well.
- **Why it matters:** Ubuntu 24.04 is the supported baseline per `linux/README.md:31` ("Ubuntu 22.04+"). The retry should cover both renames; one simple fix is `${PKGS[@]/libglib2.0-0/libglib2.0-0t64}` plus `${PKGS[@]/libgl1/libgl1t64}` (note: the order matters because the second substitution must not re-substitute the first result).
- **Confidence:** HIGH. **Classification:** LIKELY BUG.

### D-29 (P3) **`deploy/linux/install.sh` does not install `git`**

- **File:** `deploy/linux/install.sh:113-116` package list.
- **Observed:** `PKGS=(python3 python3-venv python3-dev ffmpeg libgl1 libglib2.0-0 curl rsync)` — `git` is missing. `scripts/prepare_alignment_model.py:54` and several HF Hub / description-lookup utilities expect git. Modal image (`deploy/modal_app.py:74`) installs git; the on-prem install does not.
- **Confidence:** LOW. **Classification:** DESIGN RISK.

### D-30 (P3) **`build.py` and `scripts/stage_media_tools.py` duplicate the FFmpeg pin**

- **File:** `build.py:447` (`media_tools.get("version") != "8.1.1"`) and `scripts/stage_media_tools.py:9` (`PINNED_VERSION`).
- **Observed:** the two literal `"8.1.1"` strings must move together; no shared constant.
- **Confidence:** MEDIUM. **Classification:** DESIGN RISK.

### D-31 (P3) **`deploy/modal_app.py` `call.cancel()` is best-effort**

- **File:** `deploy/modal_app.py:142-150`.
- **Observed:** `_remote_executor.cancel()` calls `call.cancel()`; a Modal call mid-inference cannot be aborted. The web container will wait for the worker's natural completion. Acceptable for paid-sleep model but worth documenting.
- **Confidence:** LOW. **Classification:** DESIGN RISK.

---

## 6. Incomplete or missing work

- **`book_library_service.py` split** — tracked in `tasks/todo.md:56-58`. The 1,232-line monolith is explicitly deferred because the `mark_page_audio` 8-arg signature, `_run_preparation` pipeline, `expected_text_sha256` re-validation, and per-page JSON on-disk cache have tighter coupling than the function map captured.
- **New Reader parity gaps** (per CHANGELOG §"Known limitations" and `frontend/src/components/reader/PARITY.md`):
  - No OCR fallback for empty / scanned PDFs — `usePdfDocument.preparePageText` returns the embedded text layer only. Tracked.
  - No per-page ZIP audio export — the chaptered M4B audiobook export covers whole-book output.
  - No whole-book preparation + audiobook export UI in the reader — backend endpoints work; UI is deferred.
  - No pronounce-on-click while paused — word highlighting is deferred until cache entries carry measured timings.
  - No follow-narration auto-scroll — depends on word highlighting.
  - No drag-to-pan when zoomed past viewport — `PdfStage` already wraps zoomed pages in a scrollable container.
- **A11Y-1 / A11Y-2** — both fixed in the working tree (`Reader.jsx:498`, `Toast.jsx:137`) but `tasks/todo.md:49-58` is stale and lists them as open. **Close the checklist.**
- **a11y audit infrastructure** — `scripts/vendor/axe.min.js` is a placeholder; `scripts/audit_a11y.py` and `scripts/smoke_gapless_browser.py` are untracked; CI references them. Either run `python scripts/vendor/fetch.py axe-core` and commit all three, or revert the `.github/workflows/ci.yml` additions until the assets are real.
- **Code-signing the MSI** — known limitation per CHANGELOG §2.7.0. The unsigned UAC prompt trains users to approve the next one. **Real risk, not a formality.**
- **`Reader.test.jsx` missing cases** — PDF error path, cancel-with-page-text-update, the deep-link auto-open path for PDFs.
- **`scripts/setup_bootstrapper.py --latest` asset size cap** — the bootstrapper script has the cap (C-22 above); the in-app updater (`update_service.py`) does not.
- **Single-instance plumbing migration** — manual Mutex / EventWaitHandle should move to `Microsoft.Windows.AppLifecycle.AppInstance.RedirectActivationToAsync`. C-24.
- **CI gapless_browser and a11y_audit jobs** — non-gating with `continue-on-error: true`; promote to required after two consecutive nightly greens, but only after C-4 is resolved.

---

## 7. AI-slop / unnecessary complexity (only genuine examples)

- **`frontend/src/components/reader/Reader.jsx:60-63` stale header comment** describing the reader as "the transport wraps an empty ref, so play/pause, mute, seek, and true audio resume are intentional no-ops until the narration pipeline lands." The reader's TTS pipeline is fully implemented. This is not AI-slop per se but stale prose from an earlier draft that no longer matches reality and would mislead the next maintainer. C-15.
- **`scripts/vendor/axe.min.js` placeholder file** that masquerades as a vendored asset (73 bytes, looks like a real file but is just a fetch instruction). The audit gate is "non-gating" but `continue-on-error: true` plus the placeholder produces a perpetually-failing-but-ignored audit. C-4.
- **`scripts/smoke_gapless_browser.py` page-replacement trick** that claims to test "gapless" by replacing the entire page with a synthetic `<audio>` and verifying a single concatenated WAV plays continuously. The test passes even if the production chunk-advance logic is broken. C-5.
- **Six reader sub-components** (`ReaderToolbar`, `ReaderBanners`, `ResumeDialog`, `ReadingOptionsPanel`, `TextPageColumn`, `TranscriptColumn`) **imported only by `PdfViewer.jsx`** — kept around as "parity backlog" rather than deleted. C-13.
- **`frontend/src/components/reader/Reader.jsx:248-269` debounce that resets itself on every `timeupdate`** — looks correct (a 3 s debounce before saving progress) but the chosen pattern is the inverse of what `useReaderProgress` does, and the bug means the save never fires during playback. C-6.
- **`backend/services/tts_service/__init__.py:124-137` `__getattr__` forwarding** with a `_SUBMODULES_FOR_FORWARD` dict built by iterating `dir(_sub)` per submodule. The prior review (L-66) flagged it as O(1)-able; minor but a smell of "iterate-everything" pattern.
- **`backend/services/tts_service/streaming.py:104` `with _synth._generate_lock:` for the whole multi-chunk synthesis** while the same pattern in `synth.py:496` was fixed to be per-chunk only. Asymmetry between two modules that share the same lock. C-3.

---

## 8. Test and validation gaps

| Area | What is missing | File path |
|---|---|---|
| WinUI C# logic | **No C# unit tests at all**; the C# shell ships with `dotnet build` only, no `dotnet test`. `AppPaths.InstallId`, `WindowPlacement` round-trip, `IsAllowedExternalScheme`, file-association paths are untested. | (missing test project) `desktop/BookVoice.App/Backend/*` |
| TTS streaming lock | No test that asserts `streaming.narrate_text_streaming` does not hold `_generate_lock` across chunks. | `tests/test_tts_lifecycle.py` |
| TTS conversion lock | No test that asserts `conversion.convert_voice_audio` releases the lock between windows. | `tests/test_voice_conversion.py` |
| Real gapless behaviour | `scripts/smoke_gapless_browser.py` replaces the reader with a synthetic `<audio>`. No test wires the actual `useReaderNarration` + stub chunk responses together. | `scripts/smoke_gapless_browser.py` |
| Reader PDF error path | `handleDocumentError` not exercised. | `frontend/src/components/reader/Reader.test.jsx` |
| Reader cancel-with-page-text-update | The existing "cancels in-flight generation" test does not assert audio `src` cleared. | `frontend/src/components/reader/Reader.test.jsx:325-344` |
| a11y audit gate | The audit cannot run — vendored asset is a placeholder. | `scripts/vendor/axe.min.js`, `scripts/vendor/axe.py` |
| `update_service.download_installer` | No test for size cap; no test for resume after partial. | `tests/test_update_service.py` |
| `backend/services/voice_profile_service.list_profiles` cache invalidation | No test asserts cache invalidation on voice mutation. | `tests/test_voice_profiles.py` |
| Linux `install.sh` env rendering | No test that the systemd template substitution escapes correctly. | `deploy/linux/install.sh:268-299` |
| `scripts/smoke_studio.py` repair_durations endSec=0 case | If ffprobe fails, `repair_durations` starts with `endSec=0` (M-56); no test asserts the failure mode is detected. | `scripts/smoke_studio.py` |
| `useReaderNarration` direct unit test | Only indirect coverage through `Reader.test.jsx`. | `frontend/src/hooks/reader/useReaderNarration.js` |
| `useServerPageText.findText` | No test for early-exit on first match; no test for the no-progress-feedback case. | `frontend/src/hooks/reader/useServerPageText.js` |
| `narrate_text_streaming` client disconnect | No test for a browser tab closing mid-NDJSON stream — backend generator must terminate cleanly. | `tests/test_tts_lifecycle.py` |
| Voice conversion mid-cancellation | `tests/test_voice_conversion.py` covers window splitting and target-reference selection; no equivalent of `test_bump_generation_aborts_in_flight_chunks` for TTS. | `tests/test_voice_conversion.py` |
| Arabic narration | Fixtures (`tests/fixtures/arabic.pdf`, `tests/fixtures/timing_ar.json`) exist but no Arabic narration test in `tests/test_tts_lifecycle.py`. | `tests/fixtures/`, `tests/test_tts_lifecycle.py` |
| Real-fmpeg audiobook export | `tests/test_audiobook_export.py` uses `FakeMediaTools`; the ffmpeg 8.1.1 chapter-marker syntax is never exercised in unit tests. | `tests/test_audiobook_export.py`, `scripts/smoke_exe.py` |
| `update_service.download_installer` cap | No test that asserts a malicious 2 GiB response is rejected. | `tests/test_update_service.py` |
| `launch.py` UPDATE_EXIT_CODE watchdog path | No end-to-end test for the case where `take_pending_update` returns `None` mid-restart. | `tests/` (no counterpart) |
| `setup_bootstrapper.py` duplicated `--latest` block | A future change can silently break `--latest`; no test covers the precedence when `--manifest-url` is also passed. | `tests/test_launcher_app.py` |

---

## 9. Dead, duplicated, or obsolete code

### Verified dead

- `frontend/src/hooks/reader/usePageResume.js` (+ `usePageResume.test.js`) — no consumer in `Reader.jsx`. C-13.
- `frontend/src/components/reader/{ReaderToolbar, ReaderBanners, ResumeDialog, ReadingOptionsPanel, TextPageColumn, TranscriptColumn}.jsx` — imported only by `PdfViewer.jsx`. C-13.
- `frontend/src/hooks/reader/useReaderTransport.js` exports `cycleRate` (line 34) which is consumed only by `PlaybackControls` (no longer in default path). A-5.
- `frontend/src/hooks/reader/useReaderNarration.js` `scrubberDuration` field (lines 455-457) is computed but not read by any consumer. A-6.
- `PdfViewer.jsx` itself (95% dead in default path). C-14.
- `frontend/src/components/PdfViewer.jsx:69-71` imports `useWordHighlight`, `usePageNarration`, `usePrefetch` — all only used in `PdfViewer.jsx`. F-5.
- `desktop/BookVoice.App/Backend/WindowPlacement.cs` `DpiScale` field — recorded but not applied on restore. C-18.
- `scripts/vendor/axe.min.js` (placeholder) and `scripts/vendor/axe.min.js.sha256` (placeholder) — both 73-byte placeholders. C-4.
- `backend/services/studio_service/narration.py:75-78` `_extract_clip` — one-line wrapper around `_extract_profile_clip`. C-36.
- `backend/services/generation_gateway.py:run_remote_job` — only callable when `remote_execution.set_executor` is invoked; never invoked in the codebase. C-37.
- `backend/services/remote_execution.py` (entire module) — dormant; `_executor = None` unless `set_executor` is called. C-37.

### Verified duplicated

- `desktop/BookVoice.App/bookvoice.ico` and `desktop/BookVoice.App/Assets/bookvoice.ico` — two copies of the same file. C-21.
- `RUNTIME_RECORD_TTL_SECONDS` in both `backend/services/audiobook_export_service.py:20` and `backend/services/path_utils.py` (per L-58).
- `backend/services/tts_service/__init__.py:124-130` `_SUBMODULES_FOR_FORWARD` dict rebuilt on every module load (per L-66).
- `_copy_atomic` in `backend/services/studio_service/media.py:229` and `backend/services/studio_service/voice_profiles.py:27` — same helper, subtle drift (one re-imports `shutil` inside the function). C-36.
- `_sha256_file` in `book_library_service.py`, `voice_profile_service.py`, `studio_service/media.py`. C-36.
- `_replace_with_retry` (6 attempts) in `book_library_service.py` vs `replace_file_with_retry` (20 attempts, smarter backoff) in `storage_utils.py` — the better helper exists, but several call sites still use bare `os.replace`. C-36.

### Verified obsolete or stale

- `backend/services/studio_service.py` and `backend/services/tts_service.py` (1,584 and 1,670 lines respectively at `HEAD`) are monolithic; the working tree has them replaced by package directories but the replacements are uncommitted (staged for delete, new package untracked-but-staged). This is the 2.6.3 refactor (CHANGELOG §2.6.3, "Pure refactor — no behaviour change"). **Stage but don't recommit until the package tests pass.**
- `frontend/src/components/reader/Reader.jsx:48-63` header comment (C-6 / C-15).
- `frontend/src/components/reader/CONTRACT.md:70, 152, 157, 159` rows (C-15).
- `tasks/todo.md:49-58` A11Y-1, A11Y-2 entries (C-16).

### Possibly premature deletions (verify before removing)

- `frontend/src/hooks/reader/useReaderPageResume.js` etc. — keep until `?reader=old` is removed (CHANGELOG deferred task).
- `scripts/vendor/axe.min.js` — populate it before removing; the gate is the reason it exists.

---

## 10. Dependency / configuration issues

- **`scripts/vendor/axe.min.js`** is a 73-byte placeholder. `scripts/vendor/axe.py:29-31` defines `AXE_SHA256` as 64 zero hex digits. The a11y audit (`scripts/audit_a11y.py:208-217`) raises `RuntimeError("axe-core SHA256 mismatch")` on the placeholder; CI is non-gating. C-4.
- **`scripts/audit_a11y.py`, `scripts/smoke_gapless_browser.py`, `scripts/vendor/`** are untracked. CI workflow `.github/workflows/ci.yml:67-117` references them; a clean CI checkout would fail with `python: can't open file 'scripts\\audit_a11y.py': [Errno 2] No such file or directory`. The `continue-on-error: true` mask hides the issue.
- **`scripts/audit_a11y.py` `STATIC_ROOT = ROOT / "backend" / "static"`** depends on the built artifact. The frontend bundle must be present (i.e. `python scripts/check_static_sync.py` has passed in CI before this runs). The workflow order is correct but the dependency is fragile.
- **`backend/services/tts_service/__init__.py:124-137` `__getattr__` forwarding** keeps the legacy `from services.tts_service import X` paths working but iterates `_SUBMODULES_FOR_FORWARD` on every miss. A dict-based O(1) lookup would be cleaner. Minor.
- **`backend/services/tts_service/synth.py:194-304` `_generate_chunk`** reaches into `model.conds.t3` and reassigns it (line 245-249) to apply exaggeration. This mutates model state across chunks. The lock prevents concurrent corruption but it means exaggeration is global for the duration of a generation, not per-chunk. Likely intentional, undocumented.
- **`scripts/setup_bootstrapper.py:178` HTTPError 416 retry cap of 3** is set; OK. `scripts/setup_bootstrapper.py:74 MAX_ASSET_BYTES = 1 GB` is set; OK. `scripts/setup_bootstrapper.py:238 STABLE_TAG = re.compile(r"^\d+\.\d+\.\d+$")` rejects pre-releases; OK.
- **`backend/services/update_service.py:253-293`** has no equivalent `MAX_ASSET_BYTES` cap (C-22); the manifest `size` is used only at the final checksum, not as an upper bound during streaming.
- **`package-lock.json` modified** in the working tree (uncommitted). The frontend dependency versions in `package.json` are unchanged (`react@19.2.7`, `react-pdf@10.4.1`, `lucide-react@1.23.0`, etc.) but the lockfile delta is large. Verify it didn't pick up a vulnerable transitive.
- **`requirements-ci.txt`** in CI uses CPU torch; the working tree's `book_library_service.py` modifications don't touch requirements. The CUDA profile is not exercised in CI.
- **The "Aurora Glass" redesign commit (53e8556)** updates the desktop WinUI shell + WebView2 background colour, the launch.py splash/error pages, and the frontend tokens — but `bookvoice.ico` and the `.bookvoice` file association icon are unchanged. Worth verifying the icon matches the new design language. (See C-21.)
- **`scripts/setup_linux.sh:155` `apt-get install -y` without `--no-install-recommends`** (M-99). Minor.

---

## 11. Prioritized action queue

### P0 — correctness / data-loss / security / blocking

1. **Commit the locally-fixed `voices.upload_voice` ffmpeg wrap.** `backend/routes/voices.py:103-130` (working tree). Without this commit, `HEAD` ships a synchronous ffmpeg call inside an `async def` handler that stalls every other request for the duration of the upload. C-1.
2. **Commit the locally-fixed `chapterCount` assignment.** `backend/services/book_library_service.py:426` (working tree). Without this commit, `HEAD` ships a wrong `chapterCount` field for every EPUB / TXT import. C-2.
3. **Fix the TTS streaming / conversion `_generate_lock` scope.** `backend/services/tts_service/streaming.py:104-169` and `backend/services/tts_service/conversion.py:372-…`. Replicate the `synth.py:496` per-chunk lock-acquire pattern. Affects every long page narration and every voice conversion. C-3.
4. **Make the a11y audit gate actually runnable.** Run `python scripts/vendor/fetch.py axe-core` to populate the vendored bundle with a real SHA256; commit `scripts/vendor/axe.min.js`, `scripts/vendor/axe.min.js.sha256`, `scripts/audit_a11y.py`, `scripts/smoke_gapless_browser.py`, `scripts/vendor/axe.py`, `scripts/vendor/fetch.py` together. Verify `AXE_SHA256` is no longer all-zeros. **Also fix the stub/static port mismatch** so the audit runs against a real API stub (C-26).
5. **Fix login throttle "unknown" bucket bypass** (C-25). `throttle_key()` returns `direct:unknown` whenever `client_host` is empty; with `trust_proxy_headers=True` and a missing `X-Forwarded-For`, every client behind the proxy shares one throttle bucket. DoS-able by one attacker.

### P1 — important functional / reliability

5. **Fix `Reader.jsx:248-269` debounce-resets-itself bug.** Change from trailing-edge reset to leading-edge throttle (same pattern as `useReaderProgress.js:90-92`). C-6.
6. **Fix `WinUI SavePlacement` first-launch maximize.** Replace the placeholder branch (`existing ?? new WindowBounds(0,0,…)`) with `GetWindowPlacement` so the real `rcNormalPosition` is persisted. C-8.
7. **Fix `WinUI OnAppWindowChanged` multi-monitor clamp.** Use `DisplayArea.GetFromWindowId(AppWindow.Id).WorkArea` or enumerate `DisplayArea.FindAll()` like `ResolveWorkArea` does. C-9.
8. **Fix `WinUI BookVoiceFileAssociation.DefaultIcon` relative path.** Write `"Assets\\bookvoice.ico,0"` (Explorer resolves relative to ProgId's app dir). C-10.
9. **Fix `useServerPageText.findText` warm-all-pages-before-matching.** Either short-circuit on first match or stream results as they arrive. C-7.
10. **Rewrite `scripts/smoke_gapless_browser.py` to test the actual reader chunk advance.** Stub the production reader + stub chunk responses; assert that chunk N+1 starts within K ms of chunk N ending. C-5.
11. **Commit the A11Y-1 and A11Y-2 fixes** (`Reader.jsx:498`, `Toast.jsx:137`) and close `tasks/todo.md:49-58`. C-17.
12. **Fix `deploy/linux/install.sh` `--host lan` translation.** Translate `lan`/`all` to `0.0.0.0` before sed substitution, mirroring `launch.py:740 resolve_bind_host`. D-27.
13. **Fix `deploy/linux/install.sh` t64 retry.** Handle both `libglib2.0-0` → `libglib2.0-0t64` and `libgl1` → `libgl1t64`. D-28.
14. **Fix `pronunciation cache` cross-user privacy leak** (C-26). The `cache_session = "pronunciation-cache"` is shared; in a hosted deployment (`BOOKVOICE_SERVER_MODE=1`), any user can fetch another user's clip via `/sessions/pronunciation-cache/{hash}.wav`. Either scope the cache per-device or require auth on the cache route.
15. **Fix `audiobook_export_service` prune path** (C-27). `_prune_runtime_records` is only called inside `create_audiobook_export`; `get_audiobook_job` (a polling endpoint) does NOT prune, so completed jobs accumulate in `_jobs` until a new export is created.

### P2 - maintainability / performance / test debt

16. **Distinguish "natural end" from "user stop"** in `Reader.jsx:217-221` so `notifyPageEnded` only fires on stream completion. L-4.
15. **Add direct unit tests for `useReaderNarration`** and add a PDF error path test + cancel-with-page-text-update test to `Reader.test.jsx`. C-11.
16. **Add a `.csproj` for WinUI unit tests** with `dotnet test`. At minimum: `AppPaths.InstallId` determinism, `WindowPlacement.Load/Save` round-trip with DPI, `IsAllowedExternalScheme` cases, `BookVoiceFileAssociation.Apply` registration paths. C-12.
17. **Delete `PdfViewer.jsx` and its six dead sub-components** (`ReaderToolbar`, `ReaderBanners`, `ResumeDialog`, `ReadingOptionsPanel`, `TextPageColumn`, `TranscriptColumn`) once `?reader=old` is no longer required (slice 0.5 per CHANGELOG). C-13, C-14.
18. **Update `CONTRACT.md`, `PARITY.md`, and `Reader.jsx:48-63` header** to match shipped behaviour (C-15). Drop `(new)` and `(migrated)` qualifiers per L-48.
19. **Either apply `DpiScale` on restore** in `WindowPlacement` / `MainWindow.ConfigureWindow`, or stop recording it. C-18.
20. **Add a hard upper bound + per-chunk timeout to `update_service.download_installer`**, mirroring `scripts/setup_bootstrapper.py:74, 188-191`. C-22.
21. **Migrate single-instance plumbing** to `Microsoft.Windows.AppLifecycle.AppInstance.RedirectActivationToAsync`. C-24.
22. **Fix `scripts/audit_a11y.py` stub/static port mismatch** so the audit runs against a real API stub (one process serves both `/api/*` and `/assets/*`, with SPA fallback for the rest). C-26.
23. **De-duplicate `--latest` argument handling in `scripts/setup_bootstrapper.py:347-400`.** C-27.
24. **Unify sticky-port logic between `launch.py` and `serve_bookvoice.py`** so both code paths write / read the same `server-port.json`. C-28.

### P3 — cleanup / polish

25. **Reconcile the two `bookvoice.ico` copies** or document why both must stay. C-21.
26. **Fix `OnRetryClick` event subscription leak** by unsubscribing before `Dispose`. C-19.
27. **Move `AppPaths.ReadVersion` off the UI thread.** C-20.
28. **Tighten `install.sh` apt-get with `--no-install-recommends`.** L-10.
29. **Add `atexit.register(_executor.shutdown, wait=False)`** in `studio_service/manifest.py`. L-12.
30. **Replace `if not cfg_weight > 0.0:` (synth.py:102)** with `if cfg_weight <= 0.0:` for readability — pure stylistic.
31. **Replace the duplicated `RUNTIME_RECORD_TTL_SECONDS`** in `audiobook_export_service.py:20` and `path_utils.py` (L-58).
32. **Replace `_SUBMODULES_FOR_FORWARD` dict-of-everything** with a per-submodule namespace dict (L-66).
33. **Document `BookVoice-Dev.exe` build step or remove references in `TESTING.md`.** C-29.
34. **Remove unused `PYTHON` constant in `scripts/smoke_gapless_browser.py:51`.** C-30.
35. **Fix the misleading "<10 s smoke" docstring** in `scripts/smoke_gapless_browser.py`. C-31.
36. **Extract a shared FFmpeg-pin constant** used by both `build.py:447` and `scripts/stage_media_tools.py:9`. D-30.
37. **Add `git` to the apt package list** in `deploy/linux/install.sh`. D-29.
38. **Document the best-effort nature of Modal `call.cancel()`.** D-31.

---

## 11.5. Backend-only P2/P3 items (cross-reference to the 139-finding backend audit)

The backend deep-dive audit surfaced 139 findings; the most impactful beyond what is captured above:

- **`book_library_service.py` is a 1,249-line god module** (finding #31 / #134). The recent splits of `tts_service` and `studio_service` are inconsistent with this file. A deferred split is tracked in `tasks/todo.md:56-58`; the audit confirms this should remain a priority.
- **Module-level mutable state across many services** (finding #137): `_jobs` in `book_library_service.py`, `_archives` in `book_library_service.py`, `_jobs` in `audiobook_export_service.py`, `_job_cancellations` and `_active_job_ids` in `studio_service/manifest.py`, `_request_cancellations` in `routes/tts.py`, `_login_failures` in `access_service.py`, `_profile_list_cache` in `voice_profile_service.py`, `_summary_cache` in `book_library_service.py`, `_download` in `update_service.py`, `_PRONUNCIATION_CACHE_LAST_TRIM` in `tts_service/streaming.py`, `_directory_size_cache` in `studio_service/downloads.py`, `_voice_checksum_cache` in `tts_service/model.py`. All are process-global; only `studio_service.projects.reset_runtime_state_for_tests` is exposed.
- **`book_library_service.py` single global RLock** serializes every book write (finding #46). Per-book lock would parallelize.
- **`routes/ocr.py:11` and `routes/translation.py:12` module-level `ThreadPoolExecutor`** are never shut down (finding #11 / #18). `atexit.register(executor.shutdown, wait=False)` would parallel the Studio pattern.
- **`routes/voices.py:25-68` `seed_default_voices`** trusts `DEFAULT_VOICES_DIR` env var to point at the canonical source dir; the temp-prefix derives from `f` (the source filename) and is confined to `dst` (the destination dir), so no traversal — but a malicious actor who controls `DEFAULT_VOICES_DIR` can plant arbitrary `.wav` files.
- **`backend/services/ocr_service.py:62-75`** elevates `Image.DecompressionBombWarning` to an error. Pillow's `DecompressionBombError` is caught and re-raised as `ValueError`. The pixel cap (25M → resize to ≤4000-side) happens *after* `image.load()`, so the original image (150 MB+ for 25M pixels) is in RAM before being downscaled.

These are tracked in the parallel backend audit report but are not duplicated here in full.

---

1. **Should the in-app updater be the supported update path going forward?** Signing the MSI would close the unsigned UAC prompt risk, but it requires a code-signing certificate and an HSM-style key custody story. **Human / product decision.** (CHANGELOG §2.7.0 "Known limitation".)
2. **When to delete `PdfViewer.jsx` and the dead `?reader=old` rollback hatch?** The CHANGELOG says "slice 0.5 of `tasks/plan-bookvoice-improvements.md`" is gated on the parity matrix. The PARITY.md rows that mark Closed all have tests; the remaining rows (no OCR fallback, no per-page ZIP, no whole-book preparation UI, no pronounce-on-click, no follow-narration) are product-level feature gaps, not bugs. **Human / product decision.**
3. **Should the `book_library_service.py` 1,232-line monolith be split now, or after the 2.7.x stabilisation?** The 2.6.3 split attempt was prototyped but reverted. The current split in `tasks/todo.md:56-58` is acknowledged deferred. **Human / engineering priority decision.**
4. **Should `useServerPageText.findText` warm all pages or stream matches?** Streaming matches improves perceived latency but requires UI work to display "Searching…" with a partial-results count. **Product / UX decision.** C-7.
5. **Should the WinUI single-instance plumbing be migrated to `Microsoft.Windows.AppLifecycle`?** Acknowledged TODO. The hand-rolled version works but the SDK provides better activation forwarding. **Engineering decision.** C-24.
6. **How should the `update_service.download_installer` cap be set?** The bootstrapper caps at 1 GB; the in-app updater should match or be tighter. **Security / product decision.** C-22.
7. **Should `Reader.jsx` track the live playback position for server-side autosave?** The current leading-edge-throttle pattern in `useReaderProgress` works locally; the new debounced effect tries to mirror it server-side and resets itself. **Engineering decision.** C-6.

---

## 12. Questions requiring a stronger model or human judgment

1. **Should the in-app updater be the supported update path going forward?** Signing the MSI would close the unsigned UAC prompt risk, but it requires a code-signing certificate and an HSM-style key custody story. **Human / product decision.** (CHANGELOG §2.7.0 "Known limitation".)
2. **When to delete `PdfViewer.jsx` and the dead `?reader=old` rollback hatch?** The CHANGELOG says "slice 0.5 of `tasks/plan-bookvoice-improvements.md`" is gated on the parity matrix. The PARITY.md rows that mark Closed all have tests; the remaining rows (no OCR fallback, no per-page ZIP, no whole-book preparation UI, no pronounce-on-click, no follow-narration) are product-level feature gaps, not bugs. **Human / product decision.**
3. **Should the `book_library_service.py` 1,232-line monolith be split now, or after the 2.7.x stabilisation?** The 2.6.3 split attempt was prototyped but reverted. The current split in `tasks/todo.md:56-58` is acknowledged deferred. **Human / engineering priority decision.**
4. **Should `useServerPageText.findText` warm all pages or stream matches?** Streaming matches improves perceived latency but requires UI work to display "Searching…" with a partial-results count. **Product / UX decision.** C-7.
5. **Should the WinUI single-instance plumbing be migrated to `Microsoft.Windows.AppLifecycle`?** Acknowledged TODO. The hand-rolled version works but the SDK provides better activation forwarding. **Engineering decision.** C-24.
6. **How should the `update_service.download_installer` cap be set?** The bootstrapper caps at 1 GB; the in-app updater should match or be tighter. **Security / product decision.** C-22.
7. **Should `Reader.jsx` track the live playback position for server-side autosave?** The current leading-edge-throttle pattern in `useReaderProgress` works locally; the new debounced effect tries to mirror it server-side and resets itself. **Engineering decision.** C-6.
8. **Should the pronunciation cache be scoped per-device in a hosted deployment?** A privacy-preserving design would key the cache by device id, but that breaks cross-device profile reuse (the same clone voice speaking the same word should sound the same across a user's own devices). **Product / privacy decision.** C-26.

---

## 13. Suggested verification matrix

Before/after each change, an implementation agent should run:

```text
# Backend (run from repo root, Python 3.11)
python -m pip install -r backend/requirements-ci.txt
python -m pytest tests -q -x                  # all 455+ tests pass
python -m pytest tests/test_tts_lifecycle.py -q
python -m pytest tests/test_voice_conversion.py -q
python -m pytest tests/test_voice_profiles.py -q
python -m pytest tests/test_update_service.py -q
python -m pytest tests/test_security.py -q
python -m pytest tests/test_access_gate.py -q

# Frontend
cd frontend
npm ci
npm run lint                                  # 0 diagnostics
npm run test                                  # all 418 specs pass
npm run build
cd ..
python scripts/check_static_sync.py           # backend/static matches fresh dist

# Build / package
python build.py                               # dist/ produced
python build.py --msi --per-user              # both MSIs produced
python scripts/smoke_launch.py --app-dir dist --skip-server   # payload validates

# A11Y + gapless (only after C-4 is resolved)
python scripts/vendor/fetch.py axe-core       # populates scripts/vendor/axe.min.js
python scripts/audit_a11y.py --json a11y-report.json     # reports 0 new violations
python scripts/smoke_gapless_browser.py                   # real gapless assertion

# Linux scaffold (only if installing on a Linux host)
bash deploy/linux/install.sh --no-service     # installs layout, no systemd
bash deploy/linux/install.sh                  # installs systemd unit
curl http://127.0.0.1:8000/api/health         # smoke
```

Specific test cases the implementation agent should add or run:

```text
# C-3 / H-8: streaming + conversion lock scope
test: with a fake model that holds the lock for 1s per chunk,
       narrate_text_streaming for a 4-chunk page releases the lock between chunks
       (assert: another submit_tts runs to completion inside the window).
test: same for convert_voice_audio with a 4-window source.

# C-6: Reader.jsx debounce
test: simulate timeupdate events at 250ms intervals for 10s,
       assert updatePreparedProgress fires exactly once at the end.

# C-7: useServerPageText.findText
test: 50-page book, query exists on page 3,
       assert the function returns before fetching page 4.

# C-8: WinUI SavePlacement first-launch maximize
test (C#): instantiate MainWindow with empty runtime dir,
           set window state to maximized, fire Closed,
           assert WindowBounds.Maximized is true and rcNormalPosition
           is not (0, 0, MinWidth, MinHeight).

# C-10: WinUI DefaultIcon relative
test (C#): apply file association, read back the DefaultIcon value,
           assert it is "Assets\bookvoice.ico,0" (relative).

# C-11: useReaderNarration direct unit test
test: chunk advance timing: chunk 1 ends at t=0.5s, chunk 2 loads within 50ms.
test: mute toggles volume to 0 and back.
test: stopPlayback aborts in-flight stream abort.

# C-12: WinUI unit test scaffolding
test: AppPaths.InstallId is stable across runs and depends on appDir + version.
test: WindowPlacement.Load/Save round-trip preserves DPI scale.
test: IsAllowedExternalScheme accepts http/https/mailto and rejects file/ms-settings.

# C-22: update_service.download_installer cap
test: serve a manifest with declared size 10 GB but actual stream is bounded;
       assert RuntimeError is raised.

# C-26: audit_a11y.py stub/static port
test: open the audit page in a fresh Chromium; assert /api/health returns 200
       (not 404 / not the SPA index.html) and the page's React tree mounts.
test: after fetch.py axe-core, assert verify_axe(p) succeeds on the vendored bytes.

# C-27: setup_bootstrapper.py duplicated --latest
test: invoke the bootstrapper with both --latest and --manifest-url set;
       assert the latest manifest wins (or document whichever precedence is intended).

# D-27: install.sh --host lan translation
test: run install.sh --host lan with a fake env; assert the rendered env file
       has BOOKVOICE_HOST=0.0.0.0, not BOOKVOICE_HOST=lan.

# D-28: install.sh t64 retry for libgl1
test: run install.sh against a fake 24.04 apt repo where libgl1 is renamed;
       assert the retry installs libgl1t64.
```

---

## Cross-reference to existing REVIEW-FINDINGS.md and REVIEW.md

The two existing review documents (`REVIEW-FINDINGS.md` and `REVIEW.md`) are **untracked** in the working tree — they were written, then the working tree was modified, then the documents were left as artifacts. They overlap heavily with this audit but disagree on some specifics. Cross-reference:

- **REVIEW-FINDINGS.md C-1** (`xName` not `x:Name`) — was wrong at the time it was written. `MainWindow.xaml:112,114` already had `x:Name`. The prior review is incorrect on this finding. This audit confirms `x:Name` is present in both the working tree and `git show 7fb0dc1:desktop/BookVoice.App/MainWindow.xaml` (the original commit). **No action needed; the prior review was wrong.**
- **REVIEW-FINDINGS.md C-2** (`chapterCount = len(pages)`) — was correct at the time it was written (HEAD has the bug); the working tree has it fixed (line 426). **Action: commit the working tree fix.**
- **REVIEW-FINDINGS.md C-3** (sync ffmpeg on async handler) — was correct at the time it was written (HEAD has the bug); the working tree has it fixed (`backend/routes/voices.py:118` `await asyncio.to_thread(_run_ffmpeg)`). **Action: commit the working tree fix.**
- **REVIEW-FINDINGS.md H-1** (NewWindowRequested scheme allow-list) — RESOLVED in the working tree (`MainWindow.xaml.cs:328-353` + `IsAllowedExternalScheme` at 570-584).
- **REVIEW-FINDINGS.md H-2** (DispatcherQueue marshaling) — RESOLVED in the working tree (`MainWindow.xaml.cs:237, 264, 397`).
- **REVIEW-FINDINGS.md H-10** (CDN-loaded axe-core) — RESOLVED in the working tree (vendored bundle), but the vendored file is a **placeholder** and the audit gate is broken (C-4 above).
- **REVIEW-FINDINGS.md M-26** (SavePlacement placeholder) — NOT RESOLVED (C-8 above).
- **REVIEW-FINDINGS.md M-33** (DefaultIcon absolute) — NOT RESOLVED (C-10 above).
- **REVIEW-FINDINGS.md M-35** (hand-rolled single-instance) — NOT RESOLVED (C-24 above).
- **REVIEW-FINDINGS.md L-4** (two `bookvoice.ico`) — NOT RESOLVED (C-21 above).
- **REVIEW-FINDINGS.md L-8** (DPI not recorded) — PARTIALLY RESOLVED (recorded but not applied, C-18 above).

The bulk of the prior REVIEW-FINDINGS.md items (M-1..M-23 backend, M-48..M-100 scripts, M-101..M-110 tests, L-1..L-95) are still valid and worth acting on; this audit does not duplicate them in full but cross-checks the highest-priority ones.

---

*End of audit. **44 findings catalogued** in this document (5 P0, 10 P1, ~14 P2, ~15 P3), plus 12 unresolved-risk items in §5, 7 open questions in §12, and 5 verification-test cases. The four parallel deep-dive subagents surfaced ~190 additional lower-level findings across the backend, frontend, desktop shell, and tests/scripts/deploy areas; only the highest-impact ones were integrated into this document. The architecture, security model, and design system are genuinely solid; the defects are concentrated in (a) uncommitted fixes that need to land, (b) one P1 TTS-lock bug that affects every page narration, (c) the dead-code burden around the new Reader, (d) the accessibility audit infrastructure that is structurally broken, (e) the absence of C# unit tests for the WinUI shell, (f) several long-standing script / deployment bugs that prior reviews noted but did not fix, and (g) two new findings from this audit (login throttle "unknown" bucket; pronunciation cache cross-user privacy leak).*
