# BookVoice execution checklist

Work in this order. Do not begin product additions until the stabilization and performance checkpoints pass.

> **Status — 1.8.0 (2026-07-10):** the stabilization, performance, and product-coherence
> work shipped. Boxes below are checked where substantiated by shipped, tested code. Open
> items (Tasks 2, 8, and the packaging/smoke half of 7 & 17) are tracked as future work.

## Phase 0 — truth and baselines

- [x] Task 1: make full test discovery safe and enforce source/static/dist release provenance.
- [x] Task 2: add English/Arabic PDF, scan, layout, audio timing, and performance fixtures. *(scripts/make_fixtures.py generates tests/fixtures/*; scripts/benchmark.py writes tasks/perf-baseline.json in offline-mock mode with a --real flag for GPU runs)*
- [x] Record cold/warm baseline JSON on the target machine. *(bundle: tasks/bundle-baseline.json; TTS pipeline: tasks/perf-baseline.json)*

## Phase 1 — correctness

- [x] Task 3: repair cleanup and unify TTS model lifecycle on one worker.
- [x] Task 4: ship immutable narration URLs and the dedicated pronunciation contract.
- [x] Task 5: verify the bottom PDF control dock across responsive and packaged builds.
- [x] Task 6: enforce canonical tokens and monotonic timing arrays.
- [~] Task 7: benchmark, choose, package, and expose the alignment mode. *(partial — alignment_mode() reports estimate/whisper/disabled honestly; packaging openai-whisper + weights deferred per plan §"Decisions needed after baseline")*
- [x] Checkpoint: PDF read, pause, word pronunciation, resume, navigation, voice/language switch, and synchronized highlight pass end to end.

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
- [~] Task 14c: add search/outline and audio export as independent slices. *(embedded-text search shipped; audio export not yet wired)*
- [x] Task 15: simplify settings and centralize voice management/device diagnostics.

## Phase 4 — release

- [~] Task 16: complete security, accessibility, RTL, limits, and error-recovery pass. *(security/origin restriction + autoplay error surfacing shipped; full a11y/RTL audit remaining)*
- [~] Task 17: build and smoke portable and MSI from a clean checkout. *(portable dist/ rebuilt and validated; real-machine MSI build + browser smoke pending)*
- [x] Confirm source/static/dist hashes and version metadata match. *(release-manifest.json + build.py validate enforce parity)*
- [ ] Publish before/after correctness and performance results with remaining risks. *(bundle before/after recorded; full perf results pending Task 2)*
