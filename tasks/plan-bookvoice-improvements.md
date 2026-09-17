# BookVoice code-quality improvement plan

> **Status — proposed:** scoped to code-quality only: reader de-duplication,
> backend mega-file splits, and the two open tasks from `tasks/todo.md`
> ("real-browser gapless smoke", "full a11y audit"). Security, code-signing,
> and repo hygiene are explicitly **out of scope** for this plan and should be
> tracked separately.

## Objective

Reduce the maintenance and bug-surface pressure created by parallel
implementations and mega-files, without regressing the test gates that already
protect each release. Every phase is a pure refactor (no behavioral change), so
phases can be reordered or abandoned at any commit without stranding the
codebase.

The ordering rule is **highest-blast-radius-per-LoC first**. A break in the
reader touches every user on first paint; a break in `studio_service.py` only
affects Voice Studio. The reader comes first; the deepest-dependency backend
split (`tts_service.py`) comes last among the splits.

## Assumptions

- Retain the React reader and the FastAPI/Chatterbox engine; they contain the
  product behaviour worth keeping.
- Every phase is gated by the existing CI matrix (`.github/workflows/ci.yml`):
  backend pytest, frontend Vitest, frontend lint, static-bundle freshness, and
  the 350 KiB initial-entry bundle budget.
- The moderate/a11y gaps flagged in `tasks/todo.md` (Whisper packaging, full
  a11y audit) are deliberately sequenced after the refactors so the audit
  isn't fighting refactor churn.
- The shared core already exists: `frontend/src/hooks/useAudioTransport.js`,
  `useTtsStatus.js`, `useUserConfig.js`, and the `frontend/src/hooks/reader/`
  set are the seams both readers use. The new reader's job is to consume them,
  not reimplement them.

## Risk model

| Phase | Touches every user? | Blast radius if it breaks | Can be reverted? |
|---|---|---|---|
| 0 — Reader de-duplication | Yes (default reader) | High (first paint, every action) | Yes — `?reader=old` flag is the rollback hatch |
| 1 — Backend mega-file splits | No (refactor) | Medium (one backend surface at a time, behind existing routes) | Yes — each slice is a no-op commit |
| 2.1 — Real-browser gapless smoke | No (test infra) | Low (adds CI; non-gating at first) | Yes — drop the workflow |
| 2.2 — Full a11y audit | No (test infra) | Low (audit produces follow-up issues, not direct fixes) | Yes — drop the harness |

---

## Phase 0 — Reader de-duplication

Today two readers ship side-by-side: `PdfViewer.jsx` (108,583 bytes) as the
default and `Reader.jsx` (27,443 bytes) behind `?reader=new`. Every reader
feature (zoom, transport, bookmarks, search, progress, resume) is implemented
twice and must stay in sync. The risk of a defect is twice the surface; the
risk of a silent divergence is invisible until the next release.

The new reader is the replacement. It must be feature-complete against the
production reader before the old one is removed — the **parity matrix** is the
gate for slice 0.5.

### 0.1 Inventory the new reader's exposed contract — **S**

Document every prop the composition root takes, every hook it composes, and
every side effect on close/unmount. Output:
`frontend/src/components/reader/CONTRACT.md`. This is the surface area
`App.jsx` and the test files depend on.

Risk: **low**. Documentation only.

### 0.2 Promote `?reader=new` to default — **S**

Flip `App.jsx:51-54` so `useNewReader` defaults to `true`; keep `?reader=old`
for one release as a rollback hatch. Update `CHANGELOG.md` "Unreleased".

Risk: **medium**. The user-visible default changes. The `?reader=old` flag is
the safety net for one minor release.

### 0.3 Wire the new reader to the shared transport core — **M**

Replace the empty-audio-ref placeholder in `Reader.jsx` and the
`useReaderTransport.js` (2,048 bytes) shim with the existing
`useAudioTransport.js` (5,742 bytes) and `useUserConfig.js`. Behaviour parity
must be verified by:
- the existing `Reader.test.jsx` suite;
- a new `Reader.test.jsx` case asserting play/pause/seek/mute parity with the
  production reader;
- the real-browser smoke from Phase 2.1 (when it exists; until then, this is
  manual).

Risk: **medium**. Mostly mechanical, but the empty-audio-ref path was
explicitly placeholder code; behaviour regressions would be user-facing.

### 0.4 Lock the new reader for one release behind `?reader=old` — **S**

The flag flips in 0.2; `?reader=old` remains available until the next minor
after the new reader has shipped clean at default. Track in `CHANGELOG.md`.

Risk: **low**. Already an existing flag.

### 0.5 Delete `PdfViewer.jsx` once the parity matrix is signed off — **M**

**Pre-condition: a parity matrix.** Before `PdfViewer.jsx` is removed, the
following Reader.jsx gaps must close. Each row is verified by an automated
test or a manual checklist entry under
`frontend/src/components/reader/PARITY.md`.

| Behaviour present in `PdfViewer.jsx` | Status in `Reader.jsx` | Gate |
|---|---|---|
| Page jump input (numeric input box) | Add if missing | Vitest |
| Page-audio export to current page | Add if missing | Unit test |
| Search-in-document (PDF text layer extraction) | Present via `useReaderSearch` | Vitest |
| Bookmark add/remove + sidebar | Present via `useBookmarks` | Vitest |
| Audio export of cached pages | Add if missing | Unit test |
| Zoom in/out + fit-to-viewport + reset | Present via `useReaderZoom` | Vitest |
| Reading position autosave keyed by fingerprint | Present via `useReaderProgress` | Vitest |
| Resume dialog ("continue where you left off?") | Present via `usePageResume` | Vitest |
| Custom-keyboard shortcuts (Space/←/→/F/B/M/Cmd-[/]) | Present via `useKeyboardShortcuts` | Vitest |
| `media-export`-style UI hooks (preparation progress, audiobook job status) | Add if missing | Vitest + manual |

After every row is checked, the deletion commit lands. `PdfViewer.jsx` and
its tests are removed; `App.jsx` no longer references the legacy viewer
(verified by `grep -r "PdfViewer" frontend/src` returning only the test
fixtures, then also clean).

Risk: **high** if the parity matrix has gaps; **low** once every row is
green. The matrix is the gate, not just the unit tests.

### Phase 0 exit criteria

- `App.jsx` no longer imports `PdfViewer` once 0.5 lands.
- Initial-entry bundle ≤ 350 KiB (currently ~310 KiB; the new reader's lazy
  chunk must remain ≤ 27 KiB).
- `frontend/src/components/reader/PARITY.md` exists with every row signed off.
- The reader test files (`Reader.test.jsx`, `ReaderToolbar.test.jsx`,
  `ReaderBanners.test.jsx` if added) cover all hooks.

### Parallelisation

**Sequential.** 0.2 unsafe to merge until 0.1 lands. 0.3 unsafe until the
shared transport is stable. 0.5 unsafe until one release cycle after 0.4.
This is by design.

---

## Phase 1 — Backend mega-file splits

Task 17 of `tasks/todo.md` already proved that backend hygiene matters — 2.6.3
was literally a code review of 2.6.2's tree and shipped multiple critical
defect fixes. Splits must keep the public surface identical so `routes/*.py`
never needs a touching edit.

Each split produces a `services/<name>/__init__.py` that re-exports the public
surface; the old `<name>.py` becomes a thin re-export shim and is deleted in
the final commit. **Every commit in Phase 1 must leave the backend pytest
green**, not just the end-of-phase state.

### 1A — Split `tts_service.py` (72,746 bytes, ~50 functions)

Balanced slicing — 7 modules. Functions grouped by concern:

| New module | Responsibility | Approx. lines |
|---|---|---|
| `services/tts_service/__init__.py` | Re-exports the public surface | thin |
| `services/tts_service/queue.py` | `TtsPriority` queue worker, `submit_tts`, `tts_queue_depth`, `TtsQueueFull`, generation tokens (`bump_generation`, `GenerationCancellation`, `GenerationCancelled`, `_raise_if_cancelled`) | ~180 |
| `services/tts_service/model.py` | Device resolution, model loading (`_load_local_en`, `_load_local_mtl`, `_local_model_path`, `_has_local_model`), conditionals (`_voice_condition_cache_path`, `_prepare_voice_conditionals`), lifecycle (`get_model`, `preload_model`, `request_reload`, `state_snapshot`), version detection (`_chatterbox_model_version`, `_is_cuda_build`) | ~430 |
| `services/tts_service/synth.py` | Chunking (`_split_into_chunks`), kwargs (`_generation_kwargs`, `_apply_pace`, `_estimate_max_new_tokens`, `_safe_exaggeration`, `_auto_guidance`), core inference (`_generate_chunk`, `_synthesize_audio`), top-level `narrate_text`, audio I/O helpers (`_audio_filename`, `_decode_pcm_mono`, `_write_pcm16_wav`), session cleanup (`maybe_cleanup_sessions`, `_reap_stream_chunks`), logging (`_log`, `_voice_reference_checksum`) | ~620 |
| `services/tts_service/streaming.py` | `narrate_text_streaming`, `export_cached_pages`, pronunciation (`pronounce_text`, `_trim_pronunciation_cache`) | ~280 |
| `services/tts_service/conversion.py` | `get_voice_converter`, `convert_voice_audio`, speech windows (`_speech_windows`, `_speech_dense_reference`, `_set_conversion_target`), filename (`conversion_filename`) | ~390 |
| `services/tts_service/studio.py` | `narrate_studio_text`, `narrate_studio_repair_text` | ~80 |

**Slice order.** Each new module is its own commit. The order respects the
dependency graph so every commit is independently green:

1. `queue.py` (no TTS imports).
2. `model.py` (depends on `queue.py` only via the cancellation token if needed;
   otherwise independent).
3. `synth.py` (depends on `model.py` and `queue.py`).
4. `streaming.py` (depends on `synth.py`).
5. `conversion.py` (depends on `model.py`).
6. `studio.py` (depends on `synth.py`).
7. Final: delete the old `tts_service.py`, replace with the package +
   `__init__.py` re-exports.

### 1B — Split `studio_service.py` (70,448 bytes)

Already partially organised; split mostly along job-kind lines:

| New module | Responsibility |
|---|---|
| `services/studio_service/__init__.py` | Re-exports |
| `services/studio_service/devices.py` | `validate_device_id`, `current_device_id`, `activate_device`, `deactivate_device`, `device_scope` |
| `services/studio_service/manifest.py` | Project manifest IO, locks, atomic writes, `_public_project`, `_normalize_interrupted_jobs`, `_prune_runtime_records` — **slice first** because every other module imports from it |
| `services/studio_service/recordings.py` | `_clean_name`, `_source_expiry`, `_delete_source_files`, `_purge_manifest_recordings`, `purge_expired_recordings` |
| `services/studio_service/projects.py` | `create_project`, `list_projects`, `legacy_projects_available`, `claim_legacy_projects`, `get_project`, `update_project`, `duplicate_project`, `delete_project`, `reset_runtime_state_for_tests` |
| `services/studio_service/jobs.py` | `_find_job`, `_patch_job`, `update_job_progress`, `submit_job`, `get_job`, `cancel_job`, `validate_generation_settings` |
| `services/studio_service/media.py` | `_media_tool_path`, `_redact_media_error`, `_run_media_tool`, `_probe_media`, `_extract_edit_audio`, `_create_video_preview`, `_waveform_peaks`, `_waveform_peaks_extensible`, `_sha256_file`, `import_source_path` |
| `services/studio_service/voice_profiles.py` | `_extract_profile_clip`, `create_voice_profile`, `_EventCancellation`, `_copy_atomic` |
| `services/studio_service/narration.py` | `create_narration`, `_extract_clip` |
| `services/studio_service/conversion.py` | `_resolve_conversion_span`, `create_conversion` |
| `services/studio_service/repair.py` | `_asset_record`, `_fit_replacement`, `_resample_and_match_channels`, `_splice_replacement`, `_read_wav_audio`, `_write_wav_pcm16`, `_session_audio_path`, `create_repair`, `export_repair_video` |
| `services/studio_service/downloads.py` | `asset_path`, `_download_file_name`, `output_download`, `_is_cancelled`, `_open_directory`, `open_project_folder` |

### 1C — Split `book_library_service.py` (50,708 bytes)

| New module | Responsibility |
|---|---|
| `services/book_library_service/__init__.py` | Re-exports |
| `services/book_library_service/paths.py` | `_prune_runtime_records`, `library_root`, `book_dir`, `_manifest_path`, `_replace_with_retry`, page-audio path helpers (`page_audio_path`, `has_valid_page_audio`, `is_page_prepared`, `prepared_audio_metadata`) |
| `services/book_library_service/io.py` | `_sha256_bytes`, `_sha256_file`, `_write_json`, `_read_json`, `_validate_wav_bytes`, `_validate_wav_file` |
| `services/book_library_service/importers.py` | `_new_manifest`, `import_pdf`, `import_pdf_path`, `import_epub_path`, `import_text_path`, `_import_extracted_path`, `import_bookvoice`, `import_bookvoice_path`, `_zip_member_digest`, `_extract_zip_member`, `_copy_file_atomic`, `_replace_book_from_staging` |
| `services/book_library_service/catalog.py` | `source_kind`, `source_filename`, `_summary`, `list_books`, `get_book`, `delete_book`, `_stop_book_jobs` |
| `services/book_library_service/pages.py` | `save_page`, `get_page`, `profile_id`, `mark_page_audio`, `cache_generated_page`, `update_progress` |
| `services/book_library_service/archives.py` | `_matches_source_magic`, `_is_archive_source_entry`, `_safe_archive_members`, `create_archive`, `get_archive`, `delete_archive` |
| `services/book_library_service/preparations.py` | `start_preparation`, `_start_preparation_locked`, `_run_preparation`, `_update_job`, `_remove_job_field`, `_job_cancel_requested`, `_job_status`, `_complete_job_page`, `_persist_job`, `get_preparation`, `_public_job`, `cancel_preparation` |

### Slice rule for all three splits

Each commit:
- keeps the public surface identical so `routes/*.py` never needs a touching
  edit;
- keeps `services/tts_service.py` (etc.) as a thin re-export shim until the
  final deletion commit;
- runs `python -m pytest tests -q` before and after — gate must stay green at
  every commit, not just at the end.

### Phase 1 exit criteria

- No file in `backend/services/` exceeds ~25 KB (today's largest after the
  split should be `tts_service/synth.py` or `studio_service/repair.py`, both
  projected under 22 KB).
- `wc -l backend/services/tts_service/*.py` and the other two no longer have
  a single file over ~700 lines.
- Backend pytest unchanged (436 passing) — every split is a no-op.

### Parallelisation

**1A, 1B, 1C can run on three branches and be merged in any order**, since
they touch disjoint functions. 1A is restricted to one developer only because
the seam ordering matters; 1B and 1C are each safe to assign in parallel.

---

## Phase 2 — Close the open tasks from `tasks/todo.md`

Both items need infrastructure (browser automation, accessibility scanner) that
is best introduced after the codebase is smaller and more stable, so the audit
isn't fighting refactor churn.

### 2.1 Real-browser gapless TTS smoke — **M**

Currently unit-tested only (`scripts/smoke_launch.py --skip-server`, the
gap-free unit test). The CHANGELOG note in 2.7.0 explicitly cites
"real-browser gapless smoke" as remaining. **Tool: Playwright.**

| # | Slice | Effort | Risk | Deliverable |
|---|---|---|---|---|
| 2.1.1 | Add `@playwright/test` as a frontend dev-dep in `frontend/package.json` and a `frontend/playwright.config.js` | S | Low | Browser pinned (Chromium only to keep CI image small). |
| 2.1.2 | Reuse `scripts/simulate_app.py` to boot a real backend on a free loopback port (already supported) and point Playwright at it | M | Medium | New `scripts/smoke_gapless_browser.py`. |
| 2.1.3 | Drive a known fixture page through the reader, assert zero audio gaps via the `<audio>` element's `currentTime` delta between chunk boundaries (gap > 50 ms = failure) | M | Medium | Single journey entry. |
| 2.1.4 | Run twice nightly for one week as non-blocking; promote to gating after two consecutive greens | S | Low | CI workflow entry; gate promotion is a separate one-line PR after the run is reliable. |

**Exit criteria.**
- `scripts/smoke_gapless_browser.py` runs locally on a CPU-only box (uses
  fixtures, not real GPU).
- Two consecutive nightly runs pass before CI promotion.

### 2.2 Full a11y audit — **M**

The 2.7.0 redesign was measured for touch targets, contrast, and 320 px
reflow, but "full a11y audit" is still open in `tasks/todo.md`.

| # | Slice | Effort | Risk | Deliverable |
|---|---|---|---|---|
| 2.2.1 | Add `axe-core` Playwright integration to the same harness from 2.1 | S | Low | Per-page scan run on `/`, `/library`, `/reader`, `/studio`, `/settings` in both modes. |
| 2.2.2 | Accessibility-tree snapshot walkthrough (`page.accessibility.snapshot()`) on the same five routes | M | Low | Recorded snapshots committed under `tests/a11y/snapshots/`; manual checklist in `HUMAN_VERIFICATION.md` updated. |
| 2.2.3 | Color-contrast sweep with `axe-core` and manual override on dark/light | S | Low | Issues filed as numbered follow-ups in `tasks/todo.md`; not necessarily fixed in this plan. |
| 2.2.4 | Keyboard-only traversal recording | S | Low | Confirms every interactive element has a focus-visible path; documented gaps filed as follow-ups. |

**Exit criteria.**
- `axe-core` reports zero violations on the five routes in both light and
  dark.
- Snapshot diffs before/after each release show no regressions.

---

## Suggested release grouping

Each numbered slice is one PR.

| Release | PRs | Rationale |
|---|---|---|
| **2.8.0** | 0.1, 0.2, 0.3, 0.4 | Reader promotion; new reader becomes default with `?reader=old` rollback. Bundle stays ≤ 350 KiB. |
| **2.8.x** (any number of point releases) | 0.5 | Delete `PdfViewer.jsx` once the parity matrix is signed off and the new reader has proven itself at default for at least one minor. |
| **2.9.0** | 1A, 1B, 1C (in any merge order, possibly in parallel branches) | Backend mega-file splits; pure refactor, no user-visible change. CHANGELOG "Changed" entry per slice. |
| **2.10.0** | 2.1.1, 2.1.2, 2.1.3, 2.1.4 | Real-browser gapless smoke. Promote to gating after two green nightlies. |
| **2.11.0** | 2.2.1, 2.2.2, 2.2.3, 2.2.4 | Full a11y audit + follow-up issues. |

This gives a clear, low-risk sequence: every release up through 2.9.0 is a
pure refactor that affects no shipped behaviour; 2.10.0/2.11.0 add CI gates
that have already proven themselves in non-gating form.

## What is explicitly out of scope

To prevent scope creep into this plan:

- **Security hardening** (`security.py`, CORS, CSP) — separate plan.
- **Code signing** for MSI/launcher — separate plan, needs a certificate and
  a signtool/CI workflow.
- **Repo hygiene** (`Old Docs/`, leaked `auto.key`, `backend/test_output.wav`
  removal, `.gitignore` cleanup) — separate one-commit hygiene PR.
- **The torch pin** (`2.5.1+cu121` vs `chatterbox-tts`'s `2.6.0`) — release-
  sized change, needs its own plan.
- **The "Aurora Glass" design system** — already shipped in this unreleased
  version; nothing to do here.

## Open follow-ups (filed by Phase 2.2)

- Whisper packaging (Task 7 continuation).
- Any `axe-core` violations surfaced by 2.2.3.
- Any keyboard-only traversal gaps surfaced by 2.2.4.

These land as numbered items in `tasks/todo.md` rather than as scopes of this
plan.
