# Changelog

## 1.10.1 - 2026-07-10

### Fixed

- Bundled embeddable Python now includes `venv` / `ensurepip` and Windows venv script binaries, so first-run environment creation no longer fails with `No module named venv`.

## 1.10.0 - 2026-07-10

### Added

- `BookVoice-User.msi` per-user installer (no admin) as the supported portable replacement, installing to `%LocalAppData%\BookVoice\App`.
- Bundled embeddable Python 3.10 under `runtime/python/` so first-run setup does not require system Python on PATH.
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
