# BookVoice execution checklist

Work in this order. Do not begin product additions until the stabilization and performance checkpoints pass.

> **Status — 1.10.0 (2026-07-10):** robust Windows packaging shipped. Per-user MSI
> (`BookVoice-User.msi`) replaces copy-paste portable; bundled embeddable Python and
> install-scoped runtime directories eliminate system-Python and version-skew failures.
> Open items: Whisper packaging, real-browser gapless smoke, full a11y audit.

## Phase 0 — truth and baselines

- [x] Task 1: make full test discovery safe and enforce source/static/dist release provenance.
- [x] Task 2: add English/Arabic PDF, scan, layout, audio timing, and performance fixtures. *(scripts/make_fixtures.py generates tests/fixtures/*; scripts/benchmark.py writes tasks/perf-baseline.json in offline-mock mode with a --real flag for GPU runs)*
- [x] Record cold/warm baseline JSON on the target machine. *(bundle: tasks/bundle-baseline.json; TTS pipeline: tasks/perf-baseline.json)*

## Phase 1 — correctness

- [x] Task 3: repair cleanup and unify TTS model lifecycle on one worker.
- [x] Task 4: ship immutable narration URLs and the dedicated pronunciation contract.
- [x] Task 5: verify the bottom PDF control dock across responsive and packaged builds.
- [x] Task 6: enforce canonical tokens and monotonic timing arrays.
- [x] Task 7: benchmark, choose, package, and expose the alignment mode. *(CTC forced alignment shipped 2026-07-14: the known narrated text is Viterbi-aligned per synthesized chunk against a bundled fp16 wav2vec2-base-960h (~180 MB, scripts/prepare_alignment_model.py); alignment_mode() reports ctc/whisper/estimate/disabled; scripts/verify_alignment.py proves placement by re-decoding each aligned word slice — 0 neighbour mismatches. Paused word-click now slices cached audio only in aligned mode and synthesizes the exact word otherwise.)*
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
- [x] Task 14c: add search/outline and audio export as independent slices. *(embedded-text search shipped; cached canonical full-page audio can be exported from page 1 through the current page; missing pages are reported rather than silently omitted)*
- [x] Task 15: simplify settings and centralize voice management/device diagnostics.

## Phase 4 — release

- [x] Task 16: complete security, accessibility, RTL, limits, and error-recovery pass. *(keyboard shortcuts, focus-visible, reduced-motion, RTL dir propagation, and transcript keyboard activation shipped; full a11y audit remaining)*
- [x] Task 17: build and smoke portable and MSI from a clean checkout. *(BookVoice.msi + BookVoice-User.msi build green; scripts/smoke_launch.py validates install dirs; copy-paste dist/ deprecated for end users; real-browser gapless smoke pending)*
- [x] Confirm source/static/dist hashes and version metadata match. *(release-manifest.json + build.py validate enforce parity)*
- [x] Publish before/after correctness and performance results with remaining risks. *(bundle before/after in tasks/bundle-baseline.json; TTS pipeline timings in tasks/perf-baseline.json; remaining risks: Whisper packaging deferred, real-browser gapless smoke, full a11y audit)*

## A11y follow-ups (from `scripts/audit_a11y.py`, run on the 2.8.0 build)

The Playwright + axe-core audit scans the five primary routes (`/`, `/library`, `/reader`, `/studio`, `/settings`) in both `light` and `dark` mode. Two unique violations are found and need a follow-up fix in the frontend. Both are site-wide; the per-route number in `scripts/audit_a11y.py` is the per-page node count (consistently 1 across all routes).

- [ ] **A11Y-1 (critical)** — `label`: The hidden file `<input type="file">` (the "Choose a book file" picker) has no implicit `<label>`, no explicit `<label>`, no `aria-label`, and no `aria-labelledby`. The visible "Choose a book file" button is rendered as a sibling, so screen readers announce the input as unlabelled. Fix: add `aria-label="Choose a book file"` to the `<input>` element (or wrap the visible button as an explicit `<label for="…">`).
- [ ] **A11Y-2 (serious)** — `aria-prohibited-attr`: The toast region `<div class="toast-region" aria-label="Notifications">` uses `aria-label` on a `<div>` with no role, which axe-core flags because `aria-label` is only valid on elements with an interactive or landmark role. Fix: add `role="region"` (or `role="status"` if a polite live region is acceptable) to the div.

## Follow-ups (deferred from `tasks/plan-bookvoice-improvements.md`)

- [ ] **Phase 1C — split `services/book_library_service.py`** (1,232 lines) into a 7-module package (`paths`, `io`, `importers`, `catalog`, `pages`, `archives`, `preparations`). Prototyped but reverted in 2.8.0 because the per-page state machine (`mark_page_audio` with its 8-arg signature, `_run_preparation`'s pipeline, the `expected_text_sha256` re-validation flow, and the per-page JSON on-disk cache) has tighter coupling than the function map captured. The `__getattr__` + `__init__.py` re-export pattern from 1A/1B carries over cleanly, but the signature changes need a dedicated slice with proper test coverage.
