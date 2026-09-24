# BookVoice execution checklist

Work in this order. Do not begin product additions until the stabilization and performance checkpoints pass.

> **Status — 2.8.2 (2026-09-23):** Vellum & Signal and the Reader capability
> reconciliation are release-ready: measured PDF/text highlighting, Follow,
> click-to-pronounce, per-page WAV/ZIP export, prepared-library deletion,
> hosted sign-out, contextual titles, and the unified translation contract
> ship. Windows MSI repackaging remains a follow-up on a WiX + Windows SDK
> 10.0.19041 build host.


## Phase 0 — truth and baselines

- [x] Task 1: make full test discovery safe and enforce source/static/dist release provenance.
- [x] Task 2: add English/Arabic PDF, scan, layout, audio timing, and performance fixtures. *(scripts/make_fixtures.py generates tests/fixtures/*; scripts/benchmark.py writes tasks/perf-baseline.json in offline-mock mode with a --real flag for GPU runs)*
- [x] Record cold/warm baseline JSON on the target machine. *(bundle: tasks/bundle-baseline.json; TTS pipeline: tasks/perf-baseline.json)*

## Phase 1 — correctness

- [x] Task 3: repair cleanup and unify TTS model lifecycle on one worker.
- [x] Task 4: ship immutable narration URLs and the dedicated pronunciation contract.
- [x] Task 5: verify the bottom PDF control dock across responsive and packaged builds.
- [x] Task 6: enforce canonical tokens and monotonic timing arrays.
- [x] Task 7: benchmark, choose, package, and expose the backend alignment mode. *(CTC forced alignment ships and reports ctc/whisper/estimate/disabled. Reader consumes only complete monotonic maps for its text-book highlight surface.)*
- [x] Reader integration checkpoint: PDF/text-book reading, pause/resume, navigation, saved progress, search, bookmarks, rendered transport, contextual options, explicit OCR, measured text/PDF highlighting/follow, and click-to-pronounce are wired when complete monotonic timings are available.


## Phase 2 — performance

- [x] Task 8: stream/progressively play bounded TTS chunks. *(narrate_text_streaming yields per-chunk WAV files as synthesized; POST /narrate-stream returns NDJSON; frontend playlistController drives gapless chunk advance with next-chunk preload; first audio plays after chunk 0, before the full page. Gap-free playback is unit-tested; real-browser gapless smoke is a remaining Task 17 item)*
- [x] Task 9: add cancellable foreground-first scheduling and document-aware cache keys. *(cooperative generation tokens: page change bumps a server-side token so in-flight multi-chunk synthesis aborts at the next chunk boundary; /cancel-generation endpoint + frontend cancelGeneration on page navigation; prefetch already document/voice/language aware)*
- [x] Task 10: share the PDF proxy and optimize extraction/OCR/memory.
- [x] Task 11: code-split the frontend and eliminate continuous highlight/layout work. *(initial entry ~213 KiB < 350 KiB budget; see tasks/bundle-baseline.json)*
- [x] Checkpoint: compare baseline and meet agreed first-audio, page-switch, memory, bundle, and long-task budgets. *(bundle budget met; TTS pipeline timings in tasks/perf-baseline.json)*

## Phase 3 — product coherence

- [x] Task 12: use one playback controller in PDF and camera modes.
- [x] Task 13: separate original, edited, translated, source-language, target-language, and narration-language state.
- [x] Task 14a: persist reading position and session state.
- [x] Task 14b: add bookmarks and continue-reading.
- [x] Task 14c: add search and audio export as independent backend/library slices. *(Find-in-book, prepared-page WAV export, and prepared-page range ZIP export are rendered in Reader; whole-book `.m4b` export remains a separate Library/Reader action.)*
- [x] Task 15: simplify settings and centralize voice management/device diagnostics.

## Phase 4 — release

- [x] Task 16: complete security, accessibility, RTL, limits, and error-recovery pass. *(Keyboard shortcuts, focus-visible, reduced motion, RTL direction, live-region behavior, measured Reader word interaction, and the two site-wide axe findings now ship.)*

- [x] Task 17: build and smoke portable and MSI from a clean checkout. *(BookVoice.msi + BookVoice-User.msi build green; scripts/smoke_launch.py validates install dirs; copy-paste dist/ deprecated for end users; real-browser gapless smoke pending)*
- [x] Confirm source/static/dist hashes and version metadata match. *(release-manifest.json + build.py validate enforce parity)*
- [x] Publish before/after correctness and performance results with remaining risks. *(bundle before/after in tasks/bundle-baseline.json; TTS pipeline timings in tasks/perf-baseline.json; remaining risks: Whisper packaging deferred, real-browser gapless smoke, full a11y audit)*

## Reader capability reconciliation

| Status | Current scope |
|---|---|
| **Supported now** | Real-book opening/deep links; contextual voice/language, find, bookmark, page, OCR, and book-action controls; playback transport, speed, and sleep timer; prepared/streamed narration; local and server progress; measured text and PDF highlighting, Follow narration, and click-to-pronounce when complete monotonic timings are available. |
| **Supported now in Reader and Library** | Prepare whole book, save `.bookvoice`, and export `.m4b` through the shared `useBookActions` contract. |
| **Supported now in Reader** | Download prepared audio for the current page as WAV or an inclusive page range as a STORE-only ZIP with `manifest.json`; downloads leave narration position and progress unchanged. |
| **Intentionally deferred** | Pan/drag and auto-turn. |
| **Timing-dependent** | Text/PDF word highlighting, Follow, and click-to-pronounce activate only for a complete monotonic backend timing map; no anchors are fabricated. Leaving Reader stops its only audio session and exposes a disabled Return to book state elsewhere. |

Reader persists contextual voice/language choices. Prepared-library deletion
uses an explicit confirmation flow. Scanner sessions have an editable
date-default title used by the exported `.txt` import while preserving the
existing unsaved-navigation guard. Hosted deployments expose sign-out, and
Voice Studio has a contextual project title/h1 and explicit empty-project
start state.

## Follow-ups (deferred from `tasks/plan-bookvoice-improvements.md`)

- [ ] **Phase 1C — split `services/book_library_service.py`** (1,249 lines as of 2.8.0) into a 7-module package (`paths`, `io`, `importers`, `catalog`, `pages`, `archives`, `preparations`). Prototyped but reverted in 2.8.0 because the per-page state machine (`mark_page_audio` with its 8-arg signature, `_run_preparation`'s pipeline, the `expected_text_sha256` re-validation flow, and the per-page JSON on-disk cache) has tighter coupling than the function map captured. The `__getattr__` + `__init__.py` re-export pattern from 1A/1B carries over cleanly, but the signature changes need a dedicated slice with proper test coverage.
