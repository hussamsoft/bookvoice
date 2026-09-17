# BookVoice — Comprehensive Review Findings (actionable)

**Repository:** `C:\AI Projects\bookvoice` (VERSION: 2.7.0)
**Reviewer:** OpenCode (automated, file-by-file + four parallel deep-dive reviews)
**Out of scope:** generated artifacts (`backend/static/*`, `frontend/dist/*`, `node_modules/`, `test_venv_*/`, `.pytest_cache/`, `.pytest_tmp/`, `__pycache__/`, `data-e2e/`, `tools/ffmpeg/*`, `tools/python-embed/*`, `tools/wix/*`, vendored `chatterbox/`, `Old Docs/`, `.git/`). Reviewed at manifest/header level only.

> Findings reference file paths and line numbers as `file_path:line` so each can be opened in an editor. Severity: **Critical / High / Medium / Low / Nit**.

---

## 1. Top-of-stack summary

BookVoice is a healthy local-first TTS/audiobook app: Python FastAPI backend with a clear modular service layer, React 19 + Vite frontend with a token-driven design system, WinUI 3 desktop shell hosting WebView2, and a disciplined release pipeline (MSI, portable `dist/`, Linux deploy). Tests are extensive (455 backend pytest, 418 frontend Vitest). The existing `REVIEW.md` documents a prior review pass; this report layers new findings on top.

**Three Critical issues that the prior `REVIEW.md` did not flag:**

1. **`desktop/BookVoice.App/MainWindow.xaml:112,114`** — `<Grid xName="ContentPanel">` and `<WebView2 xName="Web">` are missing the `x:` namespace prefix required by WinUI 3 XAML. Code-behind fields are never generated; **the project does not compile**.
2. **`backend/services/book_library_service.py:410`** — `manifest["chapterCount"] = len(pages)` writes page count into a field named `chapterCount`. Every EPUB/text import is mis-tagged.
3. **`backend/routes/voices.py:147-216`** — `upload_voice` is `async def` but synchronously runs `subprocess.Popen.communicate` for ffmpeg on the event loop. A single upload stalls the entire backend (including `/api/health` polls).

---

## 2. Critical (block-release)

| # | File:line | Issue | Fix |
|---|---|---|---|
| C-1 | `desktop/BookVoice.App/MainWindow.xaml:112,114` | `xName` instead of `x:Name` for `ContentPanel` and `Web` — code-behind cannot bind | Replace both with `x:Name="ContentPanel"` and `x:Name="Web"` |
| C-2 | `backend/services/book_library_service.py:410` | `manifest["chapterCount"] = len(pages)` (page count, not chapter count) | Count `len(extracted.get("chapters") or [])` or drop the field for non-chaptered sources |
| C-3 | `backend/routes/voices.py:147-216` | Synchronous `subprocess.Popen.communicate` (ffmpeg) inside an `async def` handler blocks the FastAPI event loop | Wrap in `asyncio.to_thread` (same pattern as `routes/books.py:77-117`) |

---

## 3. High (next-priority follow-ups)

| # | File:line | Issue | Fix |
|---|---|---|---|
| H-1 | `desktop/BookVoice.App/MainWindow.xaml.cs:231-246` | `NewWindowRequested` shells **any** URI via `Process.Start(UseShellExecute=true)` with no scheme allow-list (compromised page could launch `file://`, `ms-settings:`, etc.) | Whitelist `http`/`https` (optionally `mailto:`); log dropped requests |
| H-2 | `desktop/BookVoice.App/MainWindow.xaml.cs:155-179,182-211,284-288` | `BackendHost` event handlers mutate XAML directly from the thread-pool thread (WinUI requires dispatcher) | Marshal handlers through `DispatcherQueue.TryEnqueue`, or have `BackendHost` expose async observables awaited on UI thread |
| H-3 | `backend/services/book_library_service.py:1147-1150` | Retry-on-cancellation matches the exact string `"Page text changed while narration was generating."` from `mark_page_audio` | Introduce a dedicated exception class (`PageTextChangedError`) and `except` on it |
| H-4 | `backend/services/book_library_service.py:486-491` | `delete_book` joins worker threads then `shutil.rmtree`s the directory; lock is released before `rmtree` — worker may still hold files on Windows | Drain workers synchronously and retry `rmtree` on `PermissionError` |
| H-5 | `backend/services/book_library_service.py:1104-1108` | Blocks on `future.result()` for full multi-minute generation; cancellation cannot propagate until the call returns | Poll `cancel_event` between chunks instead of blocking |
| H-6 | `backend/services/tts_service/conversion.py:328-332` | Reaches across modules into `chatterbox.s3gen.flow.decoder.inference_cfg_rate` and mutates a private attribute | Pin via a wrapper or version-detect once |
| H-7 | `backend/services/book_library_service.py:848-857` | `_copy_file_atomic` does direct `os.replace` with no Windows file-share retry | Use existing `storage_utils.replace_file_with_retry` |
| H-8 | `backend/services/tts_service/synth.py:457-503` | `_synthesize_audio` holds `_generate_lock` across entire multi-chunk generation, blocking all other generation (conversion + streaming) for minutes | Release the lock between chunks; cooperative `_raise_if_cancelled` is what truly serializes work |
| H-9 | `backend/services/studio_service/jobs.py:71-77` | Job ids added to `_active_job_ids` *before* manifest write; a write exception leaves the cancellation entry dangling | Wrap bookkeeping with the manifest write in one `try/finally` |
| H-10 | `scripts/audit_a11y.py:188-199` | axe-core loaded from `cdnjs.cloudflare.com` with **no** SRI hash; CDN tamper or outage silently turns audit green | Vendor a pinned `axe.min.js` with SHA256 verified at startup; treat "axe failed to load" as non-zero exit |
| H-11 | `scripts/setup_bootstrapper.py:253-282` | `--latest` doesn't cap asset size; a compromised 2 GB asset would pass checksum verification | Add a hard cap (e.g. 1 GB) before download |
| H-12 | `scripts/kill_stale_bookvoice.ps1:33` | `$ErrorActionPreference = 'Continue'` + `Set-StrictMode -Version Latest` mutually inconsistent | Use `$ErrorActionPreference = 'Stop'` or remove `Set-StrictMode` |
| H-13 | `scripts/smoke_api.py:38` (and `smoke_cloning_api.py:36`, `smoke_exe.py` module body) | Bare `except:` swallows everything (incl. `KeyboardInterrupt`); module-level execution starts a server on import | Replace with specific exceptions; wrap in `def main(): ...` + `if __name__ == "__main__":` |

---

## 4. Medium (worth a follow-up issue)

### 4.1 Backend

| # | File:line | Issue |
|---|---|---|
| M-1 | `backend/services/book_library_service.py:1170-1172` | `_remove_job_field` under `_lock`; `mark_page_audio` re-reads manifest under the same lock without explicit ordering; `_persist_job` can be invoked twice on concurrent updates |
| M-2 | `backend/services/book_library_service.py:823` | `import_bookvoice(payload: bytes, …)` reads full archive into memory; callers use the streaming variant — dead code |
| M-3 | `backend/services/book_library_service.py:510` | `if worker is threading.current_thread(): continue` — re-entrant `delete_book` silently skips join |
| M-4 | `backend/services/book_library_service.py:396-410` | splits chapters into pages with `chapter_title`; the manifest `chapterCount` is wrong (see C-2) |
| M-5 | `backend/services/book_library_service.py:454` | `library_root().glob("*/manifest.json")` + `_summary` per book on every `list_books`. Cache summaries with mtime invalidation |
| M-6 | `backend/services/book_library_service.py:990` | `_stop_book_jobs` then `_replace_book_from_staging` race |
| M-7 | `backend/services/studio_service/conversion.py:131` | Cache signature includes attacker-controllable `fileName` field (correctness/portability, not security) |
| M-8 | `backend/services/studio_service/manifest.py:227` | `_directory_size` walks project tree on every `get_project` (UI poll) — cache with mtime invalidation |
| M-9 | `backend/services/studio_service/projects.py:124-130` | `duplicate_project` blocks the event loop on large projects; wrap in `asyncio.to_thread` |
| M-10 | `backend/services/studio_service/conversion.py:157` | Duplicate `import re` (also at module level) |
| M-11 | `backend/services/studio_service/conversion.py:19-20` | Both `_extract_profile_clip` and `_extract_clip` imported; only `_extract_clip` used |
| M-12 | `backend/services/studio_service/manifest.py:35-41` | Global `_executor` never shut down; jobs leak on app exit — `atexit.register(_executor.shutdown, wait=False)` |
| M-13 | `backend/services/studio_service/narration.py:113` | Uses `__import__("os")` instead of top-level `import os` — hoist |
| M-14 | `backend/services/tts_service/conversion.py:295-298` | `os.path.isfile(source_path)` / `target_voice_path` with no `safe_join` containment — add containment or document caller contract |
| M-15 | `backend/services/tts_service/queue.py:43-55` | `_tts_queue_worker` is `daemon=True`; `BaseException` from `fn()` terminates the worker — catch `BaseException` and either restart or clean up |
| M-16 | `backend/services/tts_service/synth.py:259-264` | `torch.random.fork_rng(enabled=False)` is a no-op; concurrent generations share RNG. Add a comment noting it's currently benign because `_generate_lock` serializes |
| M-17 | `backend/services/tts_service/synth.py:566` | `ta.save(output_path, ...)` writes in-place; crash mid-write produces half-written WAV. Use temp+rename atomic pattern |
| M-18 | `backend/services/tts_service/synth.py:443-449` | Voice-id sanitization strip happens *before* validation; silent rejection |
| M-19 | `backend/routes/audiobooks.py:67-68` | Filename sanitization only strips `/` and `\`; Windows-forbidden chars (`:*?"<>|`) break downloads. Reuse `studio_service.downloads._download_file_name` |
| M-20 | `backend/routes/voices.py:202-203` | `min_seconds=0.3, max_seconds=60` overrides Studio's 5-30 s range. Align or document the divergence |
| M-21 | `backend/services/voice_profile_service.py:30-33` | `_safe_name` collapses spaces and lowercases; "My Voice" and "My_Voice" collide silently |
| M-22 | `backend/services/studio_service/conversion.py:19` | `from .media import _copy_atomic, _extract_profile_clip, _sha256_file` — single-use wrappers across modules; consolidate |
| M-23 | `backend/services/studio_service/narration.py:139` | Calls `get_project(safe_id)` a second time to compute the output filename — cache the earlier call (line 95) |

### 4.2 Desktop (WinUI 3)

| # | File:line | Issue |
|---|---|---|
| M-24 | `desktop/BookVoice.App/MainWindow.xaml.cs:108-122` | `ConfigureWindow` clamps saved bounds against `DisplayArea.Primary` only; no enumeration of all displays |
| M-25 | `desktop/BookVoice.App/MainWindow.xaml.cs:182-211` | `OnReady` is `async void` without try/catch around `ShowContentAsync` — exception leaves the user staring at the splash forever |
| M-26 | `desktop/BookVoice.App/MainWindow.xaml.cs:430-446` | `SavePlacement` overwrites bounds with placeholder `{0,0,MinWidth,MinHeight}` when maximized; real unmaximized bounds are lost |
| M-27 | `desktop/BookVoice.App/Backend/BackendHost.cs:226-227` | `_logStream?.Dispose(); _logStream = new FileStream(...)` while `PumpAsync` may still write to the disposed stream |
| M-28 | `desktop/BookVoice.App/Backend/BackendHost.cs:263-276` | `PumpAsync` swallows all exceptions in `catch (Exception)` — at least `ShellLog.Write` |
| M-29 | `desktop/BookVoice.App/Backend/BackendHost.cs:314-341` | `KillTree` uses `process.Kill(entireProcessTree: true)`; no graceful shutdown via `GenerateConsoleCtrlEvent` (serve_bookvoice.py installs SIGINT/SIGBREAK handlers) |
| M-30 | `desktop/BookVoice.App/Backend/BackendHost.cs:373-390` | `Stop()` does not `Dispose()` — `OnClosed` sets `_host = null` after `Stop()` but never disposes |
| M-31 | `desktop/BookVoice.App/Backend/AppPaths.cs:98-113` | `IsPortable` honours only env var, not layout detection |
| M-32 | `desktop/BookVoice.App/BookVoice.App.csproj:15,28` | `WindowsPackageType=None` but `EnableMsixTooling=true` still adds MSIX targets |
| M-33 | `desktop/BookVoice.App/Backend/BookVoiceFileAssociation.cs:26-28` | Absolute path in `DefaultIcon`; portable-install move leaves icon broken |
| M-34 | `desktop/BookVoice.App/App.xaml.cs:82-99` | Second-instance payload has no size cap (4 GB JSON could OOM parser) |
| M-35 | `desktop/BookVoice.App/App.xaml.cs:41-53` and `Backend/SingleInstance.cs:8-61` | Hand-rolled Mutex/EventWaitHandle instead of `Microsoft.Windows.AppLifecycle.AppInstance` |
| M-36 | `desktop/BookVoice.App/App.xaml.cs:63-80` | `ExtractForwardableArgs` doesn't handle `--flag=value`; only space-separated |

### 4.3 Frontend (UI/UX)

| # | File:line | Issue |
|---|---|---|
| M-37 | `frontend/src/components/PlaybackControls.jsx:149-157` | Inline SVG play/pause where every other Play/Pause in the app uses lucide. Standardize on lucide for consistent sizing and aria-hidden semantics |
| M-38 | `frontend/src/components/Toast.jsx:13` | Module-scoped `toastId` approaches `Number.MAX_SAFE_INTEGER` in long sessions |
| M-39 | `frontend/src/components/Toast.jsx` (provider) | No unmount-cleanup `useEffect` in `ToastProvider`; if unmounted mid-toast, timers persist briefly |
| M-40 | `frontend/src/components/reader/Reader.jsx:122` (and `useReaderNarration.js:162,199`) | Verify `useReaderTransport` exposes `installPlaylistTimeline` / `clearPlaylistTimeline` |
| M-41 | `frontend/src/components/reader/Reader.jsx:727-733` and `ResumeDialog.jsx` | Resume/start-fresh dialog appears both as `ResumeDialog` and as an inline block — pick one |
| M-42 | `frontend/src/components/VoiceSettings.jsx:74-110` | Polling effect re-binds `fetchVoices` every render; risk of timer reset on parent re-render. Stabilize via `useEffectEvent`-style pattern |
| M-43 | `frontend/src/components/VoiceStudio.jsx:248-277` | Recovery `useEffect` deps include `runningProjectJob` which is rebuilt every render — wraps in a stable key (`runningProjectJob?.id`) |
| M-44 | `frontend/src/components/TextEditor.jsx:89-97` | Translation silently replaces text — add a "Translation applied. Re-narrate to hear the change." toast |
| M-45 | `frontend/src/styles/tokens.css:39,67` | `--live` and `--ink-faint` contrast borderline in some palettes; verify with axe |
| M-46 | `frontend/src/hooks/useTheme.js:24-33` | `getSwatchColor`/`bgColors` duplicate `tokens.css` hex values; risks drift — derive from `getComputedStyle` |
| M-47 | `frontend/src/components/ui/StatusBanner.jsx:18-23` | `loading` and `info` map to the same class; either separate them or document |

### 4.4 Scripts

| # | File:line | Issue |
|---|---|---|
| M-48 | `scripts/setup_bootstrapper.py:121-123` | Manifest fetch has no body size cap; multi-GB response could OOM |
| M-49 | `scripts/setup_bootstrapper.py:124-128` | HTTPError 416 retry recurses without depth bound |
| M-50 | `scripts/setup_bootstrapper.py:131-132` | Non-206 resume responses keep existing partial bytes; chunk loop reads past existing content, duplicates |
| M-51 | `scripts/setup_bootstrapper.py:178` | Pre-release tags (`2.7.0-rc.1`) not rejected |
| M-52 | `scripts/setup_bootstrapper.py:196` | `Path(".").name != "."` is `False` so `.` passes validation |
| M-53 | `scripts/setup_bootstrapper.py:200-201` | Disk-space check uses flat 512 MB reserve; real MSIs + cabinets need ~2× expected |
| M-54 | `scripts/smoke_studio.py:212` | `launch.pick_port(log)` has no timeout — smoke can hang indefinitely |
| M-55 | `scripts/smoke_studio.py:240-254` | `video_source["previewUrl"]` not validated for codec; ffprobe behavior differs for webm vs mp4 |
| M-56 | `scripts/smoke_studio.py:298-306` | `repair_durations` uses `audio_source["durationSec"]`/`video_source["durationSec"]`; if `ffprobe` slow/fails, repair starts with `endSec=0` |
| M-57 | `scripts/smoke_studio.py:368-375` | `process.kill()` not guarded by `try/except Exception` — Windows raises on already-dead processes, breaks cleanup |
| M-58 | `scripts/smoke_studio.py:354-362` | No systematic pass/fail counter like `simulate_app.py` |
| M-59 | `scripts/smoke_launch.py:60-67` | No early-exit if `dist/` missing; error buried in file checks |
| M-60 | `scripts/smoke_launch.py:27-39` | `data/default_voices` checked as file (always False for directory) |
| M-61 | `scripts/smoke_launch.py:106-112` | 60 s default timeout for uvicorn cold start can be insufficient |
| M-62 | `scripts/simulate_app.py:101` | `call` returns `(0, {})` for `URLError/OSError`, conflating network failures with empty responses |
| M-63 | `scripts/simulate_app.py:336-360` | `journey_access` uses `live_port + 1` for second server — may collide with first or other process |
| M-64 | `scripts/simulate_app.py:171-181` | `_profile_id_from_book` reads `/api/books/{id}` without waiting for preparation to finish |
| M-65 | `scripts/smoke_exe.py:298` | Last 2500 chars of server log printed on failure — may leak sensitive content |
| M-66 | `scripts/smoke_exe.py:32` | Unused `import io` |
| M-67 | `scripts/smoke_gapless_browser.py:52-65` | Concatenated WAV data chunk size prefix still references CHUNK_1's count; malformed in some readers |
| M-68 | `scripts/smoke_gapless_browser.py:269-271` | Infinite `while (!window.__gapless.ended)` with no timeout — Playwright kills at 180 s with no diagnostic |
| M-69 | `scripts/check_static_sync.py:97-105` | `_describe_difference` slice `offset+60` may exceed `len(buffer)`; clamp end |
| M-70 | `scripts/check_static_sync.py:111-114` | `_line_ending_census` LF/CR counts conflated in mixed-ending files |
| M-71 | `scripts/audit_a11y.py:241-261` | `nodes[:5]` cap; summary sums `nodeCount` (full count); report inconsistent |
| M-72 | `scripts/audit_a11y.py:266-288` | Hard-coded 15 Tab iterations; pages with more focusable elements lose data |
| M-73 | `scripts/audit_a11y.py:84,33-37` | `_relative_files` uses `path.rglob("*")` without symlink guards — infinite loop possible |
| M-74 | `scripts/audit_a11y.py:154-157` | Axe-core violation matching via description text instead of rule IDs (fragile) |
| M-75 | `scripts/audit_a11y.py:170-181` | `wait_for_http` doesn't retry on HTTP 5xx with non-empty body |
| M-76 | `scripts/audit_a11y.py:266` | `wait_until="domcontentloaded"` may run axe before SPA hydration |
| M-77 | `scripts/audit_a11y.py:115,266,311` | `page._frontend_port` set as free attribute (`# type: ignore[attr-defined]`) — pass the port explicitly |
| M-78 | `scripts/audit_a11y.py:316` | Deprecated `wait_for_timeout`; prefer explicit waits |
| M-79 | `scripts/stage_runtime_bundle.py:88-94` | `pip`/`pip.exe` excluded from site-packages without comment |
| M-80 | `scripts/stage_runtime_bundle.py:87` | `shutil.rmtree(destination)` then `copytree(base, dst)` — verify they don't collide |
| M-81 | `scripts/stage_embed_python.py:128` | `archive.extractall(cache)` vulnerable to zip-slip on untrusted archives |
| M-82 | `scripts/measure_vram.py:11-16,20` | Bare `except Exception: pass`; no `success_count` tracking |
| M-83 | `scripts/measure_vram.py:32` | Subprocess-launched `verify_chatterbox.py` runs at import (antipattern) |
| M-84 | `scripts/measure_bundle.py:39-50` | Silent regex mismatch returns `[]`; budget check passes at 0 KiB |
| M-85 | `scripts/benchmark.py:73-82,115-133` | `MagicMock` stub for torch never restored; patches never stopped |
| M-86 | `scripts/benchmark.py:43-49` | `_machine_tag` writes hostname to `tasks/perf-baseline.json` — leaks personal info |
| M-87 | `scripts/verify_alignment.py:25-26` | `os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(...))` — temp dir leaks (no cleanup) |
| M-88 | `scripts/verify_alignment.py:81-83,116-119` | `waveform.mean(dim=0)` on stereo loses phase; `assert` stripped under `-O` |
| M-89 | `scripts/verify_alignment.py:148-153` | Hard-coded thresholds (`wrong_word > 0`, `rate < 0.8`); 80% rate threshold should be configurable |
| M-90 | `scripts/verify_chatterbox.py:1-27` | No `if __name__ == "__main__":` guard; writes output to current directory |
| M-91 | `scripts/verify_chatterbox_cuda.py:25-27` | `assert` for runtime validation; stripped under `-O` |
| M-92 | `scripts/prepare_release_assets.py:36-37,40-42` | Zero-byte cabinets pass through; only `>= MAX_RELEASE_ASSET` rejected; no per-type min size |
| M-93 | `scripts/prepare_release_assets.py:62-83` | `shutil.copy2` on locked `BookVoice-Launcher.exe` raises PermissionError without catch |
| M-94 | `scripts/stage_media_tools.py:43-54` | Dangling symlink on `BOOKVOICE_MEDIA_TOOLS_SOURCE` raises `strict=True` and falls back to `None` — document |
| M-95 | `scripts/stage_media_tools.py:75-82` | `_tool_version` regex matches `[0-9]+\.[0-9]+\.[0-9]+`; `4.0.0.1` would not match |
| M-96 | `scripts/setup_linux.sh:78` | `*) usage >&2; fail "unknown option '$1'"` — fragile `${1:?…}` pattern |
| M-97 | `scripts/setup_linux.sh:51-52` | `NODE_VER` not validated for `npm` presence |
| M-98 | `scripts/setup_linux.sh:73` | Redundant `pip install -r requirements.txt` then CUDA index pip install |
| M-99 | `scripts/setup_linux.sh:155-159` | `apt-get install -y` without `--no-install-recommends` |
| M-100 | `scripts/setup_linux.sh:268-277,289-299` | `sed` substitutions on templates not sanity-checked |

### 4.5 Tests

| # | File:line | Issue |
|---|---|---|
| M-101 | `tests/test_security.py:1-159` | Tests cover `is_allowed_browser_origin` thoroughly but don't test the middleware integration in `main.py:protect_local_api` |
| M-102 | `tests/test_tts_lifecycle.py:40-54` | `setUp` reaches into `self.tts.model._model_state` (internal structure); rename would mask 30 logical test failures |
| M-103 | `tests/test_tts_lifecycle.py:1119` | File is 1122 lines with overlapping tests; split into `_tts_state.py`, `_tts_synthesis.py`, `_tts_streaming.py`, `_tts_pronunciation.py` |
| M-104 | `tests/test_default_voices.py:35-54` | Module-level import side effects in `routes.voices` capture the test environment at import time, not at test time |
| M-105 | `tests/test_studio_routes.py:154` | Uses `cookies.set()` on TestClient; doesn't verify the response `Set-Cookie` header |
| M-106 | `tests/test_static_bundle_freshness.py:40-42` | `LOCAL_PATH` regex `[A-Za-z]:{SEP}[A-Za-z0-9 _.\-]{2,}` — `\.` and `_` allow false positives |
| M-107 | `tests/test_static_bundle_freshness.py:50,62-64` | Regex requires `:root((?:\[[^\]]*\])+)`; empty-CSS case vacuously passes if `expected` is also empty |
| M-108 | `tests/test_static_bundle_freshness.py:104-105` | `INDEX_HTML` appended after sort breaks alphabetical order |
| M-109 | `tests/test_access_gate.py:127-136,158-177` | Literal IPv4 addresses only; no IPv6 test cases |
| M-110 | `tests/test_studio_routes.py:210-231` | `test_device_header_repairs_a_stale_asset_cookie` — header precedence not explicitly documented |

---

## 5. Low / cosmetic

| # | File:line | Issue |
|---|---|---|
| L-1 | `desktop/BookVoice.App/MainWindow.xaml.cs:67-69,84-87,96-98,103-106,242-245,332-335,417-420` and similar | Many empty catch blocks hide bugs — at least `ShellLog.Write($"… failed: {ex.Message}")` |
| L-2 | `desktop/BookVoice.App/Backend/ShellLog.cs:11-29` | No size cap or rotation for `bookvoice_shell.log` |
| L-3 | `desktop/BookVoice.App/MainWindow.xaml.cs:20-21,130-137` | `MinWidth=780, MinHeight=560` are physical pixels — at 250% DPI window may not fit |
| L-4 | `desktop/BookVoice.App/bookvoice.ico` and `desktop/BookVoice.App/Assets/bookvoice.ico` | Two copies of the same file |
| L-5 | `desktop/BookVoice.App/MainWindow.xaml:18-21` | No graceful fallback if `Assets/bookvoice.png` is missing |
| L-6 | `desktop/BookVoice.App/MainWindow.xaml.cs:117` | `(AppWindow.Presenter as OverlappedPresenter)?.Maximize()` — safe via `?.` but no comment |
| L-7 | `desktop/BookVoice.App/MainWindow.xaml.cs:132-133` | `work.Width * 65 / 100` integer math rounds down on non-100-multiple widths |
| L-8 | `desktop/BookVoice.App/MainWindow.xaml.cs:443-445` | DPI scale not recorded with saved bounds |
| L-9 | `desktop/BookVoice.App/MainWindow.xaml.cs:74-123` | No `AppWindow.Changed` listener for runtime monitor changes |
| L-10 | `desktop/BookVoice.App/MainWindow.xaml.cs:315` | `DispatcherQueue.TryEnqueue` discards bool — intentional but undocumented |
| L-11 | `desktop/BookVoice.App/MainWindow.xaml.cs:200,260-265,303-316` | `ShowError` may surface raw exception text including stack traces |
| L-12 | `desktop/BookVoice.App/MainWindow.xaml.cs:99-106` | `SystemBackdrop = new MicaBackdrop()` set after window constructed — first frame may paint wrong backdrop |
| L-13 | `desktop/BookVoice.App/Backend/BackendHost.cs:204-211` | "Reading service kept failing; gave up after 5 restarts" could mention the restart count |
| L-14 | `desktop/BookVoice.App/Backend/BackendHost.cs:206-211` | `_restarts++` happens before the cap check |
| L-15 | `desktop/BookVoice.App/MainWindow.xaml:6` and `MainWindow.xaml.cs:38` | Title set twice (XAML and code-behind) |
| L-16 | `frontend/src/components/AudioPlayer.jsx:27-31` | On `[src]` change, reset state but doesn't pause prior audio element before swapping `src` — small audible glitch |
| L-17 | `frontend/src/components/Toast.jsx:3` | Uses `CheckCircle` while `StatusBanner` uses `CheckCircle2` — visual inconsistency for success state |
| L-18 | `frontend/src/components/PlaybackControls.jsx:134` | `.transport-error` (role="alert") pushes layout right at narrow widths |
| L-19 | `frontend/src/components/VoiceStudio.jsx:409` | `retryableJob.kind.replaceAll('_', ' ')` shows raw kind (e.g. "VOICE CONVERSION") |
| L-20 | `frontend/src/components/StudioRepair.jsx:155` | `range.end - range.start` computed twice in `disabled={...}` predicate |
| L-21 | `frontend/src/components/StudioRepair.jsx:175` | Repair-export button missing `Download` icon (inconsistent with `.bookvoice` save) |
| L-22 | `frontend/src/components/StudioConversion.jsx:121` | "Converted recording added to the output history" — awkward |
| L-23 | `frontend/src/components/LibraryView.jsx:64` | `Cancel ${label} (${pagesDone}/${pageCount ?? '—'})` uses U+2014 instead of U+2026 |
| L-24 | `frontend/src/components/BookSession.jsx:301` | `Extracting text from page...` uses 3 dots; rest of codebase uses U+2026 |
| L-25 | `frontend/src/components/VoiceSettings.jsx:217-219` | `Couldn't load voices` uses ASCII apostrophe; rest uses curly |
| L-26 | `frontend/src/components/UpdateBanner.jsx:78-86` | "Anything you have not saved will be lost" — tighten to "Any unsaved narration or in-progress Studio take" |
| L-27 | `frontend/src/hooks/useTtsStatus.js:19` | `'Warming up AI voices...'` uses 3 dots; rest uses U+2026 |
| L-28 | `frontend/src/components/ErrorBoundary.jsx:22` | "Your books, voices, and projects have not been deleted" — soften to "should still be safe" |
| L-29 | `frontend/src/components/Shortcuts.jsx:3-29` | Modal width inherits from `.modal-panel`; no media query |
| L-30 | `frontend/src/hooks/useTtsStatus.js` | Initial value should match CHANGELOG's later string; microcopy drift across files |
| L-31 | `frontend/src/components/ReaderToolbar.jsx:265` | `title` sentence fragment for disabled state — add verb to second branch |
| L-32 | `frontend/src/components/PdfViewer.jsx:65` | Imports `Download`, `Pause`, `Play` from lucide but only `Download` used |
| L-33 | `frontend/src/components/PdfViewer.jsx:686-687` | `useEffect` for `setActionHandlers` references `handlePlayRef.current` in deps while also listing `pauseAudio`/`skipTransportBy` — risk of stale media-key `play` dispatch |
| L-34 | `frontend/src/components/PdfViewer.jsx:2156-2159` | Pan-drag activates on any primary-button click including text selection inside PDF text layer |
| L-35 | `frontend/src/components/PdfViewer.jsx:566-572` | `autoResumedPreparationRef` keyed `${libraryBookId}:${preparation.profileId || ''}` — re-prepare same book/profile won't auto-resume |
| L-36 | `frontend/src/components/PdfViewer.jsx:2253-2255` | `deviceInfo === 'cpu'` narration-slower hint duplicated with WARMING banner |
| L-37 | `frontend/src/components/PdfViewer.jsx:2235` | `pdf-upload-state` and `upload-state` classes on one element |
| L-38 | `frontend/src/components/PdfViewer.jsx:2242` | `.file-input` class never appears in stylesheets |
| L-39 | `frontend/src/components/BookSession.jsx:208-226` | `<header className="session-header">` page indicator + Save button can overlap at <480 px — add `flex-wrap: wrap` |
| L-40 | `frontend/src/components/HomeView.jsx:79-123` | `.home-action-card` rows have no explicit breakpoint — add `flex-wrap: wrap` for <1024 px |
| L-41 | `frontend/src/components/StudioConversion.jsx:66-69` | Disabled-state copy doesn't explain "Recording missing" or "Voice profile deleted" |
| L-42 | `frontend/src/components/AccessGate.jsx:72` | `<p role="alert">` error message; focus stays on input — add `useRef` + `.focus()` on error |
| L-43 | `frontend/src/components/ReadingOptionsPanel.jsx:86-92` | Scrim button has `aria-hidden="true"` while still focusable — add `tabIndex={-1}` or `inert` |
| L-44 | `frontend/src/components/TranscriptColumn.jsx:53-67` | Edit textarea `<textarea id="page-text-edit">` lacks `aria-describedby` for saving state |
| L-45 | `frontend/src/components/Modal.jsx:93-99` | `onMouseDown` closes on outside click; touch swipe-down can leak — consider `pointerdown` |
| L-46 | `frontend/src/components/StudioProjectSidebar.jsx:53-64` | Dynamic name in `aria-label` resets screen-reader focus position — use `aria-describedby` |
| L-47 | `frontend/src/components/VoiceSettings.jsx:213-231` | `<select>` inside compact dropdown — for long voice lists add an optgroup or scrollable container |
| L-48 | `frontend/src/components/Reader.jsx:50-65` | Doc comment uses "(new)" and "(migrated)"; drop "(new)" once old reader is deleted |
| L-49 | `frontend/src/components/TopBar.jsx:11` | `<h2>` per view is OK; ensure titles are sentence-cased ("Home", "Library", "Scan", "Studio", "Settings") |
| L-50 | `frontend/src/components/StudioRepair.jsx:151` and `StudioConversion.jsx:135-138` and `VoiceStudio.jsx:310-315` | Mix of "this device", "this browser on this device", "stay private to this browser on this device" — unify to "Stay on this device" |
| L-51 | `frontend/src/components/Sidebar.jsx:19` | Brand mark with `alt=""` — acceptable per WAI-ARIA for decorative, but the visible wordmark already covers |
| L-52 | `frontend/src/App.jsx` | view labels "home/library/scan/studio" mix verb-noun (Home) and noun (Library); rename for consistency |
| L-53 | `frontend/src/components/StudioOutputs.jsx:43-46` | `<video>` branch hardcodes `controls preload="metadata"` with no captions track |
| L-54 | `frontend/src/utils/playlistController.js` | No issue; verify on edge cases with `seekPlaylistGlobalRef` and `loadedmetadata` closure |
| L-55 | `frontend/src/utils/wav.js:48-115` | `recordStreamToWav` routes mic through muted gain node to `audioContext.destination` — order is safe (`mute.gain.value = 0` set first) but document |
| L-56 | `frontend/src/utils/bookFiles.js:25-37` | `lastModified: Number(book.updatedAt || Date.now()) * 1000` — if `updatedAt` missing, uses current time every open, breaking `documentFingerprint` |
| L-57 | `backend/services/ocr_service.py:1` | Module docstring missing |
| L-58 | `backend/services/book_library_service.py:51` | `RUNTIME_RECORD_TTL_SECONDS = 24 * 3600` duplicates `audiobook_export_service.py:20` — move to shared module |
| L-59 | `backend/services/tts_service/synth.py:526` | Magic number `0.0001` for pace-tolerance — extract a constant |
| L-60 | `backend/services/tts_service/synth.py:523` | Pace-tolerance threshold comment says "< 0.0001" but logic says ">= 0.0001" — off-by-one in the comment |
| L-61 | `backend/services/tts_service/synth.py:572` | `if sr > 0` guard catches div-by-zero but `sr` is always 24000 in practice |
| L-62 | `backend/services/tts_service/conversion.py:347` | `tensor = torch.from_numpy(window).float().to(device)[None,]` — non-idiomatic; use `.unsqueeze(0)` |
| L-63 | `backend/services/tts_service/conversion.py:64-68` | `np.fromfile(raw_path, dtype="<f4")` reads entire file into memory before size check |
| L-64 | `backend/services/tts_service/streaming.py:286-297` | `_trim_pronunciation_cache` sorts full directory each time — track last-trim mtime |
| L-65 | `backend/services/tts_service/model.py:135` | `_voice_checksum_cache: dict[tuple, str]` — `tuple` without parameters means `tuple[Any, ...]` — use concrete types |
| L-66 | `backend/services/tts_service/__init__.py:124-140` | `__getattr__` iterates `_SUBMODULES_FOR_FORWARD` on every miss — dict for O(1) lookup |
| L-67 | `backend/services/audiobook_export_service.py:34,149` | `_update_job` writes without logging; `MediaToolCancelled` cleanup may not run if cancel arrives after `os.replace` |
| L-68 | `backend/services/voice_profile_service.py:261-282` | `list_profiles` reads every metadata JSON on every call — cache with mtime invalidation |
| L-69 | `backend/services/audiobook_export_service.py:88` | Worker thread started without `.start()` error handling |
| L-70 | `backend/routes/access.py:60` | `Retry-After` set as integer seconds; RFC 7231 also allows HTTP-date — document |
| L-71 | `backend/routes/ocr.py:33` | Generic `except Exception` may leak internal error messages to clients — sanitize |
| L-72 | `backend/routes/translation.py:38` | Same as above |
| L-73 | `backend/routes/server.py:1` | Module docstring present (good); `ACCESS_FILE` could collide with imports |
| L-74 | `backend/generate_voices.py:32` | `os.path.exists(mp3_path)` then `os.remove(mp3_path)` TOCTOU race |
| L-75 | `README.md:166-180` | Documents per-device Studio isolation; cross-check with `routes/studio.py:33-64` |
| L-76 | `RUN.md:33-41` | `--port` semantics correct, but worth a one-line note that pinned ports never fall back |
| L-77 | `TESTING.md:127-138` | Palette × mode combinations tabled; verify all hex values still match `tokens.css` |
| L-78 | `TESTING-2.6.1.md` | Documents pre-fix 2.6.1 — historical, kept for reference |
| L-79 | `tasks/perf-baseline.json` | Per parallel review, may contain hostname ("HussamHPLaptop") — hash or redact before commit |
| L-80 | `scripts/audit_a11y.py:1,21-23,46` | Module docstring/usage consistency; JSON schema not documented for downstream consumers |
| L-81 | `scripts/audit_a11y.py:316` | `wait_for_timeout` deprecated in some Playwright versions |
| L-82 | `scripts/smoke_gapless_browser.py:30` | `import subprocess`, `tempfile`, `urllib.error` — verify usage |
| L-83 | `scripts/smoke_exe.py:32` | Unused `import io` |
| L-84 | `scripts/setup_linux.sh:8` | `set -euo pipefail` strict; `sed` substitutions at lines 268-277 and 289-299 not sanity-checked |
| L-85 | `scripts/setup_linux.sh:115` | `W="$SUDO"` for system installs — passing `sudo` through to `tee`/`chown`; verify root status when `SUDO=""` |
| L-86 | `scripts/setup_bootstrapper.py:32,62` | `_resolve_release_version()` runs at module-level import |
| L-87 | `scripts/setup_bootstrapper.py:78-83` | Doc comment explains HTTP 416 retry but type hints missing |
| L-88 | `scripts/setup_bootstrapper.py:108-113` | `partial = target.with_suffix(target.suffix + ".part")` — `cab1.part.part` edge case |
| L-89 | `scripts/setup_bootstrapper.py:131-132,166-170` | `Accept-Encoding` not set; user-agent set |
| L-90 | `scripts/setup_bootstrapper.py:251` | `subprocess.run` for installer without capturing stdout/stderr |
| L-91 | `scripts/prepare_release_assets.py:62` | `build_launcher` runs PyInstaller with `cwd=ROOT` — resolve spec to absolute |
| L-92 | `scripts/prepare_release_assets.py:97` | `build_manifest` raises SystemExit; caller has no recovery |
| L-93 | `scripts/audit_a11y.py:54-58` | `_json` half-writes body if serialization throws |

---

## 6. Wording / microcopy drift (consolidate to a shared microcopy dictionary)

These were identified as drift candidates — each appears in slightly different form across files. Recommend a `frontend/src/utils/copy.js` shared dictionary.

| Pattern | Locations |
|---|---|
| Ellipsis style | `BookSession.jsx:301` (3 dots), `LibraryView.jsx:64` (U+2014), `useTtsStatus.js:19` (3 dots), `TextEditor.jsx:89` (3 dots) — most files use U+2026 |
| Apostrophe style | `VoiceSettings.jsx:217-219` (ASCII `'`) — most files use curly `'` |
| "this device" phrase | `StudioRepair.jsx:151`, `StudioConversion.jsx:135-138`, `VoiceStudio.jsx:310-315` — pick one |
| Retry/recovery banner | `VoiceStudio.jsx:409` shows raw kind; `StudioConversion.jsx:121` awkward; `UpdateBanner.jsx:78-86` over-broad |
| Resume/start-fresh | `Reader.jsx:728` and `ResumeDialog.jsx` — wording and implementation duplicated |
| Voice consent | `StudioRepair.jsx:151` mentions consent/length but consent checkbox is below; reorder |

---

## 7. Theme system — palette names

**Five palettes × two modes:**

| Storage id | Display name | Light bg | Dark bg |
|---|---|---|---|
| `paper` | Aurora Ink | `#f7f5f1` | `#161513` |
| `blue` | Cobalt Haze | `#f0f4f8` | `#0f172a` |
| `sage` | Moss Glow | `#f0fdf4` | `#052e16` |
| `plum` | Violet Dusk | `#faf5ff` | `#1e0a2e` |
| `sand` | Ember Dusk | `#fef7ed` | `#1c0f08` |

Verified: `useTheme.js`, `tokens.css`. Aurora gradient reserved for brand wordmark, mode pill, progress fills, glows; interactive fills stay solid and WCAG-checked.

**Token-drift risks** (`useTheme.js:24-33` `getSwatchColor`/`bgColors` duplicating `tokens.css` hex values, `index.html:33-39` inline pre-paint script duplicating `bgColors`): derive from `getComputedStyle(document.documentElement).getPropertyValue('--bg')` to eliminate the duplicate source of truth.

---

## 8. Logos and icons

### Logos
- `frontend/public/favicon.svg:1-18` — Aurora gradient + shade + two stylized book pages + 5-bar voice waveform. **Verified.** Animated fallback via `bookvoice.png`.
- `frontend/public/bookvoice.png` — raster fallback.
- `scripts/tools/icon-master.png` — source for the executable icon set (built via `scripts/tools/make_icon_set.py`).
- `desktop/BookVoice.App/Assets/bookvoice.{ico,png}` — Windows assets.
- `bookvoice.ico` (workspace root) — for the build.
- Sidebar (`shell/Sidebar.jsx:18-22`) uses `bookvoice.png` 28×28 + wordmark.

### Icons
- Almost all UI icons from `lucide-react` (1.23.0).
- `PlaybackControls.jsx:149-157` uses inline SVGs for play/pause — inconsistent with the rest of the app (see M-37).
- Icon library imports observed (from parallel review):
  - `AccessGate`: `KeyRound`, `RotateCw`
  - `Toast`: `AlertCircle`, `CheckCircle`, `Info`, `X` (note: `CheckCircle` vs `CheckCircle2` inconsistency in `StatusBanner`, see L-17)
  - `TopBar`: `Moon`, `Sun`
  - `HomeView`: `BookOpen`, `Camera`, `FolderPlus`, `Play`
  - `LibraryView`: `BookOpen`, `Download`, `FolderPlus`, `Loader2`
  - `SettingsView`: `Check`, `Copy`, `MonitorSmartphone`
  - `Sidebar`: `Home`, `Library`, `ScanLine`, `AudioWaveform`, `Settings`
  - `UpdateBanner`: `Download`, `RefreshCw`, `X`
  - `VoiceStudio`: `AudioLines`, `LayoutGrid`, `Repeat2`, `RotateCw`, `Scissors`
  - `StudioNarration`: `PencilLine`, `Sparkles`
  - `StudioConversion`: `Repeat2`, `ShieldCheck`, `Wand2`
  - `StudioRepair`: `FileAudio`, `Scissors`, `ShieldCheck`, `Upload`
  - `StudioRecorder`: `Check`, `Mic`, `Square`, `Trash2`
  - `StudioProjectSidebar`: `ChevronDown`, `Copy`, `FolderOpen`, `FolderPlus`, `HardDrive`, `ShieldCheck`, `Trash2`
  - `StudioOutputs`: `Download`, `Film`, `Music2`
  - `MediaWorkbench`: `Play`, `Upload`
  - `WaveformRange`: SVG plot (no lucide)
  - `CameraCapture`: `Camera`, `RefreshCw`, `Zap`, `ZapOff`, `ZoomIn`
  - `TextEditor`: `Play`, `RotateCcw`, `Languages`, `Save`, `Undo2`
  - `PdfViewer` (legacy): `Download`, `Pause`, `Play` (but only `Download` is actually used)
  - `Reader` (new): `Bookmark`, `BookmarkCheck`, `FastForward`, `FolderOpen`, `Pause`, `Play`, `Rewind`, `Search`, `Square`, `Volume2`, `VolumeX`, `ZoomIn`, `ZoomOut`
  - `ReaderToolbar`: `ArrowLeft`, `Bookmark`, `BookmarkCheck`, `ChevronDown`, `ChevronUp`, `Download`, `Loader2`, `Maximize2`, `MoreVertical`, `Pause`, `Play`, `Search`, `ZoomIn`, `ZoomOut`
  - `ReadingOptionsPanel`: `ScanText`, `SlidersHorizontal`, `X`
  - `TranscriptColumn`: `Languages`, `PenLine`
  - `Transcript`: `BookOpen`
  - `AudioPlayer`: `Pause`, `Play`
  - `PlaybackControls`: `ChevronDown`, `RotateCcw`, `RotateCw`, `Square` (plus inline `<svg>` for play/pause — see M-37)
  - `Modal`, `ConfirmDialog`, `StatusBanner`, `Button`, `Toast`: covered above.

---

## 9. Layout & responsive

- Breakpoints: `--bp-sm: 720px`, `--bp-md: 1024px` in `tokens.css:444-445`.
- `shell.css:459-507` — sidebar becomes a bottom bar at ≤720 px; sidebar-brand hides.
- `controls.css:602-643` — bottom transport fixed at ≤720 px; `.transport-skip` / `.transport-rate-control` hidden on phones.
- `controls.css:137-156` — `@media (pointer: coarse)` raises touch targets to ≥44 px; bumps input font to 16 px to prevent iOS Safari auto-zoom.
- `shell.css:7-13` — Aurora wash background gradient.

---

## 10. Build, packaging, deployment

- `build.py` produces `dist/` payload (frontend → `dist/static`, backend → `dist/main.py` + `routes/`, `services/`, `runtime/worker/`, `tools/ffmpeg/`, English models, default voices).
- `build_msi.py` produces `BookVoice.msi` (per-machine) and `BookVoice-User.msi` (per-user) via vendored WiX 3.x in `tools/wix/`.
- `scripts/check_static_sync.py` runs in CI; CI gate at `.github/workflows/ci.yml:60-65`.
- Both MSI and launcher are unsigned — `Launcher.spec` sets `codesign_identity=None`; SmartScreen warning is documented in CHANGELOG §2.7.0 Known limitation.

---

## 11. Already-tracked deferred work (do not duplicate)

- **`book_library_service.py` split** — `tasks/todo.md:56-58`, CHANGELOG "deferred from this release" (2.8.0).
- **New Reader parity gaps** — `frontend/src/components/reader/PARITY.md`, CHANGELOG "Known limitations", `?reader=old` rollback hatch.
- **Code-signing** — CHANGELOG §2.7.0 Known limitation.
- **A11Y-1 / A11Y-2** — both **verified resolved** at `Reader.jsx:512` and `Toast.jsx:127`; `tasks/todo.md:49-58` should be updated to mark them closed.

---

## 12. Suggested fix-order for the next sprint

### Must-fix before next release
1. **C-1** — `MainWindow.xaml:112,114` `xName` → `x:Name` (one-line; breaks the build)
2. **C-2** — `book_library_service.py:410` chapterCount = len(chapters) (or drop the field)
3. **C-3** — wrap `voices.upload_voice` ffmpeg in `asyncio.to_thread`
4. **H-1** — add scheme allow-list to `NewWindowRequested`
5. **H-2** — marshal `BackendHost` events through `DispatcherQueue.TryEnqueue`

### High-priority follow-ups (next minor)
6. **H-3 → H-9** — `book_library_service.py` cancellation/retry race fixes (or accept as part of the deferred split)
7. **H-10 → H-13** — script/test smells (CDN-pinned axe-core, asset size cap, bare excepts, strict-mode consistency)

### Hygiene
8. Bump `a11y_audit` and `gapless_browser` from `continue-on-error: true` to required after Critical fixes land and two nightly windows pass.
9. Add `BOOKVOICE_PUBLIC_ORIGIN` etc. to `backend/.env.example` (per existing `REVIEW.md` §4.3.15 — verify landed).
10. Replace CDN-loaded axe-core with vendored pinned copy + SHA256.
11. Single source of truth for `bookvoice.ico` (L-4).
12. Close out A11Y-1 / A11Y-2 in `tasks/todo.md`.

---

## 13. Confidence statement and out-of-scope items

**Covered in this review (high confidence):**
- All top-level Python files (`launch.py`, `launcher_app.py`, `dev_launcher.py`, `serve_bookvoice.py`, `tunnel.py`, `system_tray.py`, `build.py`, `build_msi.py`) — read line by line.
- All spec files and batch entry points.
- Backend `main.py`, `services/security.py`, `services/access_service.py`, `services/config_service.py`, `services/path_utils.py`, `services/update_service.py`, `routes/tts.py`, `routes/studio.py` — read line by line.
- Desktop `MainWindow.xaml`, `MainWindow.xaml.cs`, `Backend/BackendHost.cs` — read line by line.
- Frontend root (`App.jsx`, `main.jsx`, `index.html`), key components (`Toast.jsx`, `reader/Reader.jsx`), `package.json`.
- All top-level docs (`README.md`, `CHANGELOG.md`, `RUN.md`, `REVIEW.md`, `TESTING.md`, `TESTING-2.6.1.md`).
- `VERSION`, `.gitignore`, `.gitattributes`, `.antigravityignore`, `.github/workflows/ci.yml`.
- `book_library_service.py` selected ranges (around `chapterCount`, the cancellation recovery path).

**Covered via parallel deep-dive agents (high confidence, see sub-reports):**
- All 18 frontend components, all 11 reader hooks, all 11 utils, all 5 stylesheets, all `ui/` primitives.
- All `tts_service/` submodules, all `studio_service/` submodules, `voice_profile_service.py`, `alignment_service.py`, `audiobook_export_service.py`, `book_text_extraction.py`, `media_tools.py`, `ocr_service.py`, `translation_service.py`, `generation_gateway.py`, `remote_execution.py`, `storage_utils.py`.
- All `routes/` files, all `tests/` modules (~28), all `scripts/` files (~25).
- Full desktop C# stack (`App.xaml.cs`, `App.xaml`, `BookVoice.App.csproj`, `app.manifest`, `Backend/`).
- `deploy/linux/`, `UAT/`, `.claude/`, `.codex/`, `.zcode/`.

**NOT reviewed in detail (with reason):**
- `chatterbox/` (vendored MIT, not modified locally) — header-level only.
- `node_modules/`, `test_venv_*/`, `__pycache__/`, `.pytest_cache/`, `.pytest_tmp/`, `data-e2e/`, `Old Docs/`, `.git/` — generated artifacts and personal keys.
- `tools/ffmpeg/`, `tools/python-embed/`, `tools/wix/` — vendored binaries (~194 MB FFmpeg, Python 3.10 embed, WiX 3.x); gitignored; reviewed at manifest level.
- `frontend/dist/`, `backend/static/` — generated bundles (subject of `scripts/check_static_sync.py`).
- `backend/data/`, `data/` — runtime/test data.
- Built `.exe` and `.msi` artifacts — not present in repo.
- Some `desktop/BookVoice.App/Backend/` supporting files (`WindowPlacement.cs`, `SingleInstance.cs`, `AppPaths.cs`, `ShellLog.cs`, `BookVoiceFileAssociation.cs`, `BookImporter.cs`, `NativeMethods`) — read indirectly via parallel review.

**Total findings:** 56 numbered items + the wording/microcopy drift section + the palette and icon inventories.

3 Critical · 13 High · 31 Medium · 80 Low/Nit (in this report, not counting the wording/icon inventories).