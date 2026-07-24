# Changelog

## 2.1.3 - 2026-07-23

### Added

- Voice Studio adds persistent local projects for typed English/Arabic narration and waveform-guided audio or video phrase repair.
- Audio and video references can create reusable, consent-gated voice profiles with duration, loudness, clipping, silence, and sample-quality feedback.
- Studio narration includes pace, expression, temperature, guidance, and repeatable variation-seed controls, plus transcript-based sentence correction that creates a new immutable WAV version.
- Media repair preserves imported sources, creates loudness-matched and crossfaded WAV versions, and can remux repaired audio into a compatible MP4 without replacing the original video.
- Release payloads now include pinned FFmpeg and FFprobe 8.1.1 executables, checksums, and license notices in both runtime and release manifests.

### Fixed

- Pace is now applied once to the completed narration with FFmpeg's pitch-preserving `atempo` filter, eliminating the phase-vocoder doubling and hall-like echo that could occur on chunked speech.
- Expression now stays in Chatterbox's safer exaggeration range with an adaptive automatic guidance curve; manually entered guidance remains an exact override.
- Advanced delivery controls now explain their lower and higher endpoints, show semantic value labels, and provide persistent accessible help.
- Voice Studio output actions now save automatically to the Windows Downloads folder without overwriting existing files, and every project has an Open Folder action for its complete managed project directory.
- Standalone Voice Studio narrations now include short leading and trailing silence so the first and last spoken sounds are not clipped; phrase-repair clips remain tightly trimmed for clean crossfades.
- Uploaded videos now use a generated H.264/AAC browser preview and a substantially taller responsive player, preventing audio-only black frames for otherwise valid MOV, MKV, WebM, and other imports.
- Create Narration now exposes media-derived voice cloning as its first step and automatically selects the new profile, so typed narration is conditioned on the imported speaker instead of silently using the default voice. Packaged smoke coverage now proves both WAV- and MP4-derived profiles reach Chatterbox synthesis.
- Opening Reading options (or any other panel) while the AI models are still loading no longer blanks the window. The reader now renders on the CPU, so a busy GPU can no longer take the display driver — and the window with it — down mid-load.
- Pages that whole-book preparation has already finished now play immediately, instead of being narrated again while the rest of the book is still being prepared. Previously prepared audio was only used once the whole book had finished.

### Changed

- The dark theme is now a warm "dark paper" that matches the cream light theme, with clearer separation between the background, panels, and raised surfaces. The cold blue-grey shades and the flat, single-tone look are gone.

### Fixed

- The desktop title bar now follows the selected dark or light theme instead of retaining a light-only gradient in dark mode.
- Whole-book preparation is now used by the Play action after preparation completes or the app is reopened: persisted page WAVs load immediately instead of being generated again.
- Verified prepared audio remains playable while the TTS worker is warming up or unavailable; only new narration requires the worker.

## 2.1.1 - 2026-07-15

### Fixed

- Reopening a book after closing BookVoice during whole-book preparation no longer exposes worker state or fails with “cannot load this book”; completed pages resume safely.
- Page edits made during generation can no longer receive narration for stale text, and duplicate or destructive preparation operations are synchronized.
- Re-importing a `.bookvoice` file atomically replaces stale prepared content while preserving newer reading progress.
- Narration cancellation is request-scoped, so stopping one page or closing a stream does not cancel unrelated book preparation.
- Dense PDF pages up to the prepared-page limit can use the existing bounded narration chunker.
- Voice uploads, prepared-book exports, and OCR image decoding are hardened against interrupted writes and oversized decompressed images.
- Release builds now reject stale launchers and publish checksum metadata for every required external MSI cabinet.

### Changed

- The Windows release includes a small setup bootstrapper that downloads and verifies the offline runtime cabinets before launching the selected per-user or machine-wide MSI.

## 2.1.0 - 2026-07-14

### Added

- Completed page narration is now saved automatically in the persistent prepared-book library, using per-page WAV files, word timings, checksums, and atomic replacement so interrupted work remains resumable.
- The prepared library and in-book toolbar show resume position, generated-page count, bookmark details, and direct bookmark navigation.
- A persistent dark theme, a named `BookVoice Natural` built-in voice, and selectable narration speeds from 0.75x through 2x.

### Fixed

- PDF interaction now uses true pointer-captured grab-and-drag panning. The mouse wheel scrolls normally; Ctrl+wheel zooms.
- PDF word highlighting is rebound after final aligned narration timings arrive, restoring synchronized highlighting in both the PDF text layer and transcript.
- Whole-book preparation preserves every completed page across cancellation or restart and never promotes partial or corrupt WAV files.
- Narration waits for the completed canonical audio and final alignment map before playback, so the displayed generation state and highlighting cannot lag behind early chunk playback.

### Changed

- Missing page text is extracted with bounded concurrency before whole-book narration, reducing setup time without changing synthesis, alignment, or audio quality.
- Removed the title-bar privacy slogan while retaining the sparkle icon.

## 2.0.1 - 2026-07-14

### Added

- Reader navigation now groups page movement, zoom, follow-narration, and a one-click return to the actively narrated page. The PDF supports wheel zoom and click-drag panning when enlarged.
- `package_msi.bat` builds both the machine-wide and per-user MSI installers from a double-clickable Windows entry point.

### Fixed

- PDF fit sizing uses the available reading area and keeps enlarged pages centered until the reader intentionally pans them; pages no longer jump to the far right after zooming.
- Follow narration now turns itself off when a reader moves away from the narrated page during playback, avoiding disruptive page jumps.
- Highlight timing uses a smaller playback correction so the active word leads the trailing visual marker more closely.

### Changed

- The player is now only a narration transport. PDF controls are beside page navigation, while voice, language, OCR, and other setup actions remain in Reading options.
- Removed the “Read with your ears” title-bar tagline.

## 2.0.0 - 2026-07-12

### Added

- Responsive progressive narration transport with independent buffering and playback states, immediate pause, dedicated stop, cross-chunk seeking, and cached word-range pronunciation.
- Equal-width PDF and wrapped-text reader, quiet editorial theme, reading-options panel, independent scrolling, and a sticky bottom player with optional text-only narration following.
- Persistent SHA-256-addressed prepared-book library, resumable background preparation, stable prepared audio, and reading progress.
- Validated `.bookvoice` import/export with active-profile audio, checksums, safe archive paths, launcher support, and MSI file association.
- Frameless desktop window with an integrated, theme-matched title bar: the brand strip is the drag region and hosts minimize/maximize/close controls, so the OS chrome no longer breaks the reading theme. The splash and startup-error screens carry the same chrome.
- Exact word-level narration timestamps via CTC forced alignment: the known narrated text is Viterbi-aligned against a bundled wav2vec2 acoustic model (~180 MB, staged by `scripts/prepare_alignment_model.py`), per synthesized chunk so timing error cannot accumulate across sentences. `alignment_mode` now reports `ctc`; Whisper and estimates remain as fallbacks. Verified end to end by `scripts/verify_alignment.py`, which decodes each aligned word's audio slice back to text.

### Fixed

- Clicking a word while paused could speak a neighboring word: the pronunciation flow sliced cached page audio using estimated timings. Slicing now happens only when timings are force-aligned (using measured word end times plus a small pre-roll so leading plosives are not clipped); otherwise the exact word is synthesized, which is always correct.
- The immutable worker runtime contract now requires `torchaudio` and `transformers` alongside `torch`, so CTC force-alignment cannot ship without its acoustic-model stack.

### Changed

- The desktop UI now opens as soon as the backend health check succeeds; model warming no longer blocks library browsing or cached playback.
- The app now fills the window with no page-level scrolling: the title bar and mode tabs are fixed rows, the reading stage claims the rest, and only the PDF page and follow-along transcript scroll. The window's minimum size (1024×700) is pinned to the smallest size at which the side-by-side reader fits without squishing.

## 1.10.1 - 2026-07-10

### Fixed

- Release payloads now ship a prebuilt immutable worker under `runtime/worker/`, so first launch never creates a virtual environment or runs `pip`.

## 1.10.0 - 2026-07-10

### Added

- `BookVoice-User.msi` per-user installer (no admin) as the supported portable replacement, installing to `%LocalAppData%\BookVoice\App`.
- Bundled Python 3.10 worker runtime so startup does not require system Python on PATH.
- Install-scoped runtime directories under `%LocalAppData%\BookVoice\installs\<id>\` with one-time migration from the legacy flat runtime.
- `scripts/smoke_launch.py` for automated install-directory validation.

### Changed

- `BookVoice.bat` is now a thin wrapper around `launch.py --browser`; launcher behavior is unified (health probe, port scan, stale cleanup).
- `dist/` is documented as a build artifact only; end users should install via MSI.

### Deprecated

- Copy-paste `dist/` folder as an end-user distribution format.

## 1.9.0 - 2026-07-10

### Added

- Progressive TTS chunk streaming for earlier first audio, with cooperative cancellation and gap-safe playlist handling.
- Cached multi-page audio export from page 1 through the current reader page.

### Fixed

- Wait for the backend health endpoint before opening the reader, preventing an initial false “Could not load voices” message during portable startup.
- Completed keyboard, focus, reduced-motion, and RTL hardening for reader controls.

## 1.8.0 - 2026-07-10

### Added

- Shared PDF and camera playback controls with progress seeking, 10-second skip, speed selection, and audio download.
- Persistent PDF page, playback time, zoom, speed, bookmarks, and continue-reading state.
- Embedded-text search across PDF pages and centralized voice management.
- Release manifests and content-hash validation for source, portable, and installed assets.
- Word-timing mode reporting: the narration status and each response now state whether highlights use estimated or Whisper-aligned timings, instead of silently falling back.
- A reproducible frontend bundle-size baseline (`tasks/bundle-baseline.json`) and a measurement script.

### Changed

- Moved the PDF control dock below the PDF and follow-along transcript.
- Split PDF, camera, and settings code into on-demand bundles, reducing the initial entry (JavaScript plus CSS) from about 672 kB to 213 kB, well under the 350 kB budget.
- Limited speculative narration to one adjacent page and made stale prefetch results cancellable.
- Reused the PDF.js document proxy instead of parsing each PDF twice.

### Fixed

- Removed the invalid page-index requirement from paused word pronunciation.
- Made narration filenames immutable across voice, language, text, and partial-clip changes.
- Fixed TTS preload cleanup and routed model loading, reload, and inference through one worker.
- Hardened highlight timing with monotonic validation and interpolation, and a clearly reported fallback to estimates when forced alignment is unavailable.
- Preserved reviewed, edited, and translated PDF text while navigating pages.
- Surfaced forced-alignment failures in logs instead of swallowing them silently.
- Made the default Python test suite deterministic and offline.

### Security

- Restricted browser access to localhost origins and added defensive response headers.
