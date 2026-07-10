# BookVoice execution checklist

Work in this order. Do not begin product additions until the stabilization and performance checkpoints pass.

## Phase 0 — truth and baselines

- [ ] Task 1: make full test discovery safe and enforce source/static/dist release provenance.
- [ ] Task 2: add English/Arabic PDF, scan, layout, audio timing, and performance fixtures.
- [ ] Record cold/warm baseline JSON on the target machine.

## Phase 1 — correctness

- [ ] Task 3: repair cleanup and unify TTS model lifecycle on one worker.
- [ ] Task 4: ship immutable narration URLs and the dedicated pronunciation contract.
- [ ] Task 5: verify the bottom PDF control dock across responsive and packaged builds.
- [ ] Task 6: enforce canonical tokens and monotonic timing arrays.
- [ ] Task 7: benchmark, choose, package, and expose the alignment mode.
- [ ] Checkpoint: PDF read, pause, word pronunciation, resume, navigation, voice/language switch, and synchronized highlight pass end to end.

## Phase 2 — performance

- [ ] Task 8: stream/progressively play bounded TTS chunks.
- [ ] Task 9: add cancellable foreground-first scheduling and document-aware cache keys.
- [ ] Task 10: share the PDF proxy and optimize extraction/OCR/memory.
- [ ] Task 11: code-split the frontend and eliminate continuous highlight/layout work.
- [ ] Checkpoint: compare baseline and meet agreed first-audio, page-switch, memory, bundle, and long-task budgets.

## Phase 3 — product coherence

- [ ] Task 12: use one playback controller in PDF and camera modes.
- [ ] Task 13: separate original, edited, translated, source-language, target-language, and narration-language state.
- [ ] Task 14a: persist reading position and session state.
- [ ] Task 14b: add bookmarks and continue-reading.
- [ ] Task 14c: add search/outline and audio export as independent slices.
- [ ] Task 15: simplify settings and centralize voice management/device diagnostics.

## Phase 4 — release

- [ ] Task 16: complete security, accessibility, RTL, limits, and error-recovery pass.
- [ ] Task 17: build and smoke portable and MSI from a clean checkout.
- [ ] Confirm source/static/dist hashes and version metadata match.
- [ ] Publish before/after correctness and performance results with remaining risks.
