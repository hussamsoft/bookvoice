# BookVoice stabilization and optimization plan

> **Status — 1.8.0 (2026-07-10):** this roadmap shipped. See `tasks/todo.md` for the
> reconciled checklist (open items: Tasks 2 & 8, plus the packaging half of Task 7 and
> the MSI/smoke half of Task 17). The text below is the original audit and is retained
> as the design rationale.

## Objective

Make BookVoice reliable as an installed Windows reading app: the shipped UI must match source, PDF controls must sit below the reading surface, click-to-pronounce must work while paused, spoken audio and highlighting must remain perceptually synchronized, and common reading actions must feel immediate even when TTS generation itself is expensive.

This is an audit and implementation roadmap, not an assertion that every current uncommitted change is ready to ship. The existing worktree contains a large in-progress refactor. Preserve it, but stabilize and test it in small vertical slices.

## Current evidence baseline

- Frontend: 28 tests pass; production build succeeds; lint reports 6 warnings.
- Backend unit suite: 26 tests pass when limited to `tests/`.
- Full `pytest` is broken because `test_api.py` starts a server and calls `sys.exit()` during collection; the active Python 3.14 environment also lacks `deep_translator`.
- Production JavaScript is 672.16 kB minified (203.70 kB gzip), plus a 1.05 MB PDF worker. Vite reports the main chunk as oversized.
- `frontend/dist` is newer than the UI in `backend/static` and `dist/static`; the app and installer therefore do not currently exercise the latest React source.
- Live browser verification and a performance trace were not possible in this audit because the Chrome DevTools connector is unavailable.

## Architecture direction

Use one explicit reading-session state machine shared by PDF and camera flows. Treat document identity, page text revision, voice, language, and synthesis options as part of every cache key. Keep all CUDA/TTS lifecycle operations on one worker. Foreground playback must be cancellable and must outrank speculative work. Use measured word timing when available and a clearly reported fallback when it is not.

```text
PDF/camera input
  -> canonical page text + revision
  -> narration request key (document, page, revision, voice, language, options)
  -> cancellable priority TTS pipeline
  -> chunk audio + monotonic word timings
  -> one playback controller
  -> PDF text layer and transcript highlights
```

The release pipeline is part of the product: source, portable `dist`, backend dev static files, and MSI must be generated from the same revision and validated by hashes and smoke tests.

## Confirmed and high-confidence defect inventory

### Critical / major

| Finding | Evidence and impact | Planned resolution |
|---|---|---|
| TTS preload can fail before model load | `maybe_cleanup_sessions()` contains a stray return referencing undefined `session_id`, `filename`, `segment_meta`, `wav`, and `sr`; preload calls it with `force=True`. | Remove the dead return, add a regression test that executes cleanup and preload boundaries, and smoke a real packaged startup. |
| Installed UI can be stale | Current frontend output hash differs from both served static copies. Source fixes can pass tests while the app still runs old JavaScript. | Make `build.py` the only assembly path; add source/build provenance and hash parity checks; smoke the portable and MSI payloads. |
| Paused word pronunciation uses a version-sensitive contract | Current source adds `/tts/pronounce`, while the prior flow sent a word through page narration and triggered `page_index must be an integer`. | Keep a dedicated typed pronunciation endpoint, add contract tests at API and browser levels, and reject mixed-version artifacts during packaging. |
| Accurate alignment is effectively disabled | `alignment_service.py` imports `whisper`, but neither `backend/requirements.txt` nor `build.py` packages it. Every normal install silently falls back to estimates. | Select and package an alignment strategy deliberately; expose alignment mode/status; never silently advertise exact word sync while estimating. |
| Timing arrays can be invalid | unmatched forced-alignment tokens remain `0`; partial/subset alignments can be non-monotonic, while lookup assumes sorted times. | Build a token reconciliation layer, interpolate gaps between anchors, assert finite monotonic timestamps, and fall back atomically if quality is too low. |
| Audio cache entries can reference overwritten files | full clips use `page_N.wav`; partial clips use page and word index only. Voice, language, text edits, and document identity are omitted, so different cache entries can resolve to the same overwritten URL. | Use immutable generation IDs/content hashes in filenames and cache keys; test voice/language/text switching and browser caching. |
| Foreground work is not truly prioritized | a priority queue cannot interrupt a prefetch already generating; scheduled jobs have no cancellation. A page click can wait behind speculative TTS. | Add cooperative cancellation between chunks, discard stale generations, and permit at most one bounded next-page prefetch. |
| CUDA work is split across two workers | preload/reload uses `TTS_EXECUTOR`; narration uses a separate custom priority worker although comments promise one thread. | Unify model load, reload, switch, and inference on one owned worker and test lifecycle ordering. |
| Document races can apply stale results | page loads, OCR, translation, TTS, and delayed prefetch lack document/page request tokens. Rapid navigation or opening another PDF can populate the current UI/cache with old results. | Introduce document IDs, operation IDs, AbortControllers where supported, and stale-result guards before every state/cache write. |
| PDF is loaded twice | `react-pdf` loads the document and `usePdfDocument` independently calls `pdfjs.getDocument()` on the same full ArrayBuffer. | Share the PDF proxy from `Document.onLoadSuccess`, clean it up on replacement, and benchmark memory on large files. |

### Moderate / minor

- The toolbar has been moved below the PDF/transcript in source, but responsive, keyboard, and packaged verification are absent.
- `waitAudioReady()` has no error path or timeout; missing/corrupt audio can leave an operation pending indefinitely.
- `audio.play()` failures are swallowed and UI state may still be set to playing.
- edited or translated PDF text is only local state; cache invalidation means navigating away can re-extract and lose the revision.
- narration language and translation target are conflated. Selecting Arabic can send untranslated English text to the Arabic model, and “Translate to English” may translate already-English text.
- simplistic PDF reading-order sorting can scramble columns, headers, footnotes, RTL text, and hyphenated line wraps.
- OCR fallback occurs only for empty text; pages with a tiny/broken embedded text layer do not trigger OCR quality fallback.
- continuous `requestAnimationFrame` polling and `scrollIntoView({behavior:'smooth'})` on nearly every word can create layout/scroll work throughout playback.
- partial timing sentinels (`-1`) can be used as seek targets when clicking words before a partial clip's start.
- transcript words are clickable `span` elements without keyboard semantics, focus states, or accessible button roles.
- icon-only refresh/delete/page buttons lack consistent accessible names; page arrows communicate direction poorly.
- settings do not close on outside click or Escape; save feedback fires for every field change; unused import remains.
- six lint warnings include hook dependency issues in the playback path.
- the old `AudioPlayer` is unused while its useful speed and skip controls were not carried into `NarrationPlayback`.
- full-suite test discovery is unsafe because executable smoke scripts are named like pytest modules.
- there are no realistic PDF interaction tests: `PdfViewer.test.jsx` checks only the initial upload label.
- there is no error boundary for PDF.js, media, or component render failures.
- wildcard CORS permits arbitrary websites to call the localhost API, including generation and voice mutation endpoints. Local binding alone does not mitigate browser-origin requests.
- translation sends book content to a third-party Google endpoint without an explicit privacy/online notice or offline alternative.
- OCR and TTS may both retain GPU models, risking VRAM pressure on 8 GB cards.
- a full PDF is held in memory and OCR uses base64 data URLs, increasing peak memory on large/scanned books.
- no structured timing/queue/cache metrics exist, so “slow” cannot be attributed to startup, extraction, inference, alignment, or rendering.

## Feature disposition

### Improve and keep

- PDF reading: bottom control dock, sticky within the reader, clearly grouped into navigation, playback, zoom, text tools, and voice/language.
- follow-along: accurate transcript and in-page highlight, click/keyboard seek, paused pronunciation, auto-scroll only when the active word leaves the viewport.
- playback: progress bar, elapsed/remaining time, 10-second skip, 0.75x–2x speed, previous/next page, and an explicit stop/cancel action.
- voice profiles: preview before selection, clearer recording quality guidance, rename, duplicate-name handling, and a settings-owned management screen.
- OCR review: confidence/quality warning, rotate/crop, re-OCR, preserved manual corrections, and correct English/Arabic reading order.
- translation: explicit source and target languages, original/translated toggle, privacy notice, retry, and preserved source text.
- camera mode: retain as a secondary capture workflow, but use the same playback controller, session state, and text revision model as PDF.
- settings: device diagnostics, effective device after restart, model availability, cache/storage controls, and a small diagnostics export.

### Add, in priority order

1. Persistent library/session resume: remember document fingerprint, page, word/time, text revisions, voice, language, zoom, and speed.
2. Bookmarks and “continue reading”; then in-book text search and page thumbnails/outline.
3. Download/export generated page or chapter audio with deterministic naming and metadata.
4. Keyboard shortcuts and accessible reader commands.
5. A diagnostics panel showing model state, queue, cache hits, timings, GPU/CPU mode, and actionable errors.
6. Optional offline translation only after the core reader is stable and its model footprint is acceptable.

### Remove, merge, or de-emphasize

- Remove the dead `AudioPlayer` after migrating speed/seek behavior into the shared playback controller.
- Remove Apple MPS from the Windows-distributed settings UI; retain it only in cross-platform developer builds if supported and tested.
- Move voice creation out of the always-visible PDF toolbar; keep selection in the dock and management in settings.
- Replace separate, divergent PDF and camera playback implementations with one controller/hook.
- Remove silent best-effort behavior for alignment, autoplay, and prefetch; these should expose fallback/cancel states to diagnostics.
- Avoid pre-generating four neighboring pages by default. Start with the next page only, informed by measured idle GPU capacity.
- Do not add more decorative modes or AI features until core reading, resume, and playback metrics meet their targets.

## Implementation phases and tasks

### Phase 0 — establish truth and prevent regressions

#### Task 1: Make test and release provenance trustworthy

Convert `test_api.py` into an opt-in smoke tool outside pytest discovery, add a release manifest containing app version/source revision/static hashes, and fail assembly when frontend, backend, and dist are mixed.

Acceptance criteria:
- `python -m pytest -q` collects without starting a server or exiting from module import.
- portable and backend static hashes match the newly built frontend assets.
- a build cannot pass with stale or missing source modules such as `alignment_service.py`.

Verification: frontend test/lint/build; backend full suite; `python build.py`; manifest/hash assertion.

#### Task 2: Add reproducible correctness and performance fixtures

Create small English and Arabic text PDFs, scanned PDFs, two-column pages, repeated-word/punctuation cases, and fixed WAV timing fixtures. Add a benchmark script for cold start, model ready, first audio, full page, alignment, page switch, memory, and VRAM.

Acceptance criteria:
- timings are reported separately for extraction, queue wait, synthesis, alignment, transfer, and first playback.
- fixtures can reproduce pause/click/seek and highlight drift without network access.
- baseline results are stored as machine-tagged JSON, not hard-coded anecdotes.

### Phase 1 — restore core correctness

#### Task 3: Repair and unify the TTS lifecycle

Fix session cleanup, move preload/reload/inference onto one worker, make model state transitions explicit, and add timeouts/cancellation boundaries.

Acceptance criteria:
- cold launch reaches ready or a truthful actionable error.
- cleanup never references synthesis locals and is independently tested.
- no CUDA/model operation runs on an unowned worker.

#### Task 4: Stabilize immutable narration and pronunciation contracts

Use typed API models and immutable generation URLs keyed by document/text revision/voice/language. Complete the dedicated pronunciation flow and reject stale results.

Acceptance criteria:
- paused word click sends no page index and plays only the requested word.
- resume begins at that word without auto-resuming during pronunciation.
- switching voice/language/text cannot reuse overwritten or browser-stale audio.

#### Task 5: Make PDF reader layout and controls coherent

Implement the bottom dock as part of the reader layout, with desktop/tablet/mobile wrapping and stable height. Separate primary playback from secondary OCR/edit/translate actions.

Acceptance criteria:
- controls appear below the rendered PDF/workspace in source, portable, and MSI.
- PDF remains usable at 320 px width, 100%/200% zoom, and Windows display scaling.
- all controls have names, focus states, tooltips where useful, and predictable tab order.

#### Task 6: Build deterministic token mapping and timing validation

Normalize PDF, narration, and aligner tokens once; handle punctuation, repeated words, hyphenation, Arabic shaping, and partial clips. Reject non-monotonic or low-coverage timing arrays.

Acceptance criteria:
- timestamps are finite, monotonic, within audio duration, and cover at least the agreed threshold.
- gaps are interpolated only between valid anchors; otherwise the entire page uses the documented fallback.
- PDF and transcript identify the same word index for all fixtures.

#### Task 7: Select and integrate an alignment strategy

Benchmark packaged Whisper variants or a lighter forced aligner against estimate-only timing. Account for install size, CPU/GPU contention, first-load cost, English/Arabic quality, and whether alignment can run incrementally per chunk.

Acceptance criteria:
- median and 95th-percentile highlight error targets are set from fixture measurements; proposed initial goals are <=100 ms median and <=250 ms p95.
- the installed package contains every required model/dependency or explicitly reports estimate mode.
- alignment does not delay first audio; it may refine later chunks in the background.

Checkpoint: all P0/P1 fixtures pass; pronunciation and highlight flows are verified in a real packaged browser; no mixed artifacts.

### Phase 2 — remove latency and rendering waste

#### Task 8: Deliver progressive chunk playback

Generate sentence/phrase chunks and make the first playable chunk available without waiting for the full page. Continue generation behind playback with a bounded buffer and gap-safe playlist/controller.

Acceptance criteria:
- time to first audio improves by at least 40% from the measured GPU baseline.
- playback has no audible gaps in normal operation and degrades clearly if generation falls behind.
- stop, page change, voice change, and document close cancel obsolete chunks.

#### Task 9: Replace speculative prefetch with cancellable scheduling

Deduplicate in-flight work, prefetch only the next likely page when idle, and make every cache document/revision aware. Add memory/disk caps and cleanup.

Acceptance criteria:
- foreground work never waits behind a complete prefetch page.
- opening a new PDF cannot receive old PDF text/audio.
- cache hit/miss/eviction and queue wait are observable and covered by tests.

#### Task 10: Optimize PDF extraction and OCR

Share one PDF proxy, improve reading-order reconstruction, apply a text-quality threshold before OCR fallback, avoid unnecessary base64 copies, and release canvases/documents promptly.

Acceptance criteria:
- large PDF peak memory and page-switch latency improve against baseline.
- column, RTL, header/footer, and scanned fixtures produce stable reviewed text.
- manual corrections and translations persist as page revisions across navigation.

#### Task 11: Reduce frontend startup and playback work

Lazy-load PDF/camera/voice-management code, split vendor chunks, remove dead assets/components, update highlights only on word changes, and scroll only when outside the visible region.

Acceptance criteria:
- the initial main chunk is below the agreed budget (initial target: <350 kB minified).
- playback produces no recurring long task above 50 ms on the test machine.
- lint has zero warnings and hook dependencies are correct.

Checkpoint: compare baseline JSON; confirm improved first audio, page navigation, memory, and continuous playback in source and portable builds.

### Phase 3 — unify the product experience

#### Task 12: Create one playback controller for PDF and camera

Merge play/pause/seek/speed/progress/word activation and error handling. Keep presentation adapters for PDF text-layer highlighting and transcript rendering.

Acceptance criteria:
- PDF and camera have identical playback semantics and controls.
- autoplay rejection, missing audio, and media errors produce recoverable UI states.
- keyboard shortcuts and screen-reader announcements work.

#### Task 13: Separate language, translation, and text revision state

Model source language, narration language, translation target, original text, translated text, and edited revisions explicitly.

Acceptance criteria:
- selecting a narration voice/language never silently translates text.
- original and translated text can be toggled/restored without loss.
- third-party translation use is disclosed before content is sent.

#### Task 14: Add persistent reading progress and focused reader features

Implement local session resume first, then bookmarks, search/outline, and audio export as separate vertical slices.

Acceptance criteria:
- closing/reopening restores document, page, word/time, speed, zoom, voice, language, and text revision where the document remains available.
- every added feature has storage migration, empty/error state, and uninstall/privacy behavior documented.

#### Task 15: Simplify settings and voice management

Move creation/rename/delete/preview into settings, show effective device/model diagnostics, remove unsupported platform choices from production, and coordinate OCR/TTS GPU ownership.

Acceptance criteria:
- the reading dock remains compact.
- an 8 GB GPU configuration cannot unknowingly pin both heavy models without warning or policy.
- settings close with Escape/outside click and persist with a single clear success/error state.

### Phase 4 — release hardening

#### Task 16: Security, accessibility, and resilience pass

Restrict localhost API origins, add an error boundary, validate file/media limits, audit keyboard/RTL/contrast/reduced motion, and ensure user-facing errors omit sensitive paths.

Acceptance criteria:
- an unrelated web origin cannot mutate the localhost API.
- all reader actions are keyboard operable and named in the accessibility tree.
- malformed/oversized PDF, image, WAV, and failed network cases recover without app restart.

#### Task 17: Package and smoke the real shipping formats

Build from a clean checkout, install dependencies in the supported Python version, exercise portable and MSI flows, and verify writable state remains under `%LocalAppData%\BookVoice`.

Acceptance criteria:
- upload PDF -> read -> synchronized highlight -> pause -> pronounce -> resume -> next page works in both formats.
- cold/warm performance and GPU/CPU modes are recorded.
- uninstall/reinstall preserves or removes user data according to an explicit choice and no source/dist drift remains.

## Definition of done

- Every task has automated tests plus the appropriate real-browser or packaged smoke check.
- Full frontend/backend suites, lint, build, artifact parity, and security checks pass.
- Performance claims include before/after measurements on the same machine and fixture.
- Highlight accuracy is measured, not judged only by visual impression.
- Source and generated artifacts are never committed in contradictory states.
- Known fallback modes and remaining risks are visible to the user and documented.

## Key risks and mitigations

| Risk | Mitigation |
|---|---|
| Better alignment makes generation slower | stream first audio, align per chunk, benchmark lightweight models, expose estimate mode. |
| Cancellation leaves CUDA/model state corrupt | cancel only at tested chunk boundaries and keep one model-owning worker. |
| Large PDFs exhaust memory | one PDF proxy, bounded caches, explicit cleanup, size warnings, large-file fixtures. |
| Existing refactor hides regressions | land tasks as small slices with packaged checkpoints; do not merge all current changes as one opaque commit. |
| Translation/privacy expectations are unclear | explicit opt-in disclosure and original/translated state separation. |

## Decisions needed after baseline, not before

- Alignment engine/model choice and whether its files are bundled or downloaded once.
- Exact performance budgets for the target GPU and acceptable CPU fallback behavior.
- Whether offline translation is worth its model size.
- Whether camera mode remains top-level or moves under an “Add page from camera” action after usage review.
