# Changelog

## 2.4.1 - 2026-08-26

### Fixed

- UI audit: migrated all hardcoded `rgba(0,0,0,…)` to `color-mix(in srgb, var(--ink) X%, transparent)` across tokens, shell, reader, studio, and controls stylesheets — dark/light themes now map mechanically from semantic tokens.
- Added `color-scheme: light` to `:root` (was missing; dark already had it).
- Added unified motion tokens: `--dur-instant` (80ms), `--dur-meter` (90ms), `--dur-toast` (160ms), `--dur-word-underline` (180ms); replaced hardcoded ms across all stylesheets.
- Touch targets for `.icon-btn`, `.audio-transport-toggle`, and `.btn.compact` now meet WCAG 2.5.5 / Apple HIG 44px minimum on `@media (pointer: coarse)`.
- Data-loss bugs fixed: `runJob` error swallowing in studio components (StudioRecorder.keep, StudioNarration.repairSentence, StudioRepair.createProfile, StudioConversion source/target clamp), PdfViewer progress-save debounce-and-cancel replaced with throttle + pagehide/visibilitychange flush, edit-text mode now survives page navigation, `capabilities.js` response shape mismatch (`data?.capabilities`).
- Added `<Document onLoadError>` handler in PdfViewer with user-friendly messages for encrypted/network/corrupt PDFs.
- Added `onError` callback to AudioPlayer with `MEDIA_ERR_DECODE`/`NETWORK`/`SRC_NOT_SUPPORTED` handling.
- SettingsPanel now renders a disabled placeholder gear during config loading (was null → TitleBar gear flashed in/out).
- Outside-click focus loss fixed in ReadingOptionsPanel, ReaderToolbar, and SettingsPanel — all route through `close()` which returns focus to the trigger.
- Modal now wires `aria-labelledby` to its `<h2>` and locks body scroll while open.
- App mode buttons use `aria-current="page"` instead of misused `aria-pressed` (nav destinations, not toggles).
- Added mode-epoch ref to App.jsx; BookSession async handlers (handleCapture, handleNarrate) ignore promise resolutions after a mode switch — no more React state-update-on-unmount warnings or phantom toasts.
- VoiceSettings: `consentConfirmed` now resets after upload/record (was a legal footgun — prior consent silently reused), `handleDeleteVoice` routes through shared `ConfirmDialog` instead of `window.confirm`, `fetchVoices` retry capped at 10 before announcing a final "gave up" toast, client-side WAV validation rejects non-WAV files before upload.
- BookSession step indicator now shows all 4 steps (was clamping to 3).
- Toast: `aria-live` conflict resolved — single polite region, toasts use `role="alert"`.
- Simulation: added TTS model-ready wait gate (`/api/tts/status`) so TTS-dependent journeys don't time out on slow CPU model loads.

### Test results

- Frontend unit: 241/241 passing
- Backend pytest: 406/406 passing (397 passed + 9 subpassed)
- Simulation journeys: 60/60 passing (9 journeys)

## 2.4.0 - 2026-08-24

### Added

- A complete visual redesign of the app shell, reader, and Voice Studio built
  on a versioned design-token system: warm paper surfaces in light mode and
  first-class "night listening" dark mode (now following the OS preference on
  first run), a display/UI/reading type system (Fraunces, IBM Plex Sans,
  Literata, Noto Naskh Arabic for Arabic reading contexts) self-hosted with
  per-subset loading, a dedicated Signal color reserved for narration and
  live audio, and a documented z-index/breakpoint/control-height ladder
  asserted by the styles-parity test.
- The narration transport gained a seek bar wired to the whole-book playlist
  timeline, and the reader toolbar is regrouped into labeled clusters with an
  overflow menu. Reading options moved into a desktop popover / mobile bottom
  sheet; loading states use skeletons; the prepared library lists every book
  in a scroll area.
- Voice Studio surfaces adopt the new skin: token-styled selects and a
  progress meter, a docked job strip replacing the floating card, Signal-hued
  waveform selection and recorder meters, and a windowed per-word correction
  list that stays fast on very long scripts.
- Toasts coalesce repeats and animate in/out; dialogs fade and scale in;
  mode switching shows an underline indicator instead of a toast; CPU
  slowdown banners render as amber warnings; buttons show pressed states.
- The reader now opens **EPUB and plain-text books** (`.epub`, `.txt`, `.md`)
  alongside PDFs and `.bookvoice` archives. Chapters are extracted on import
  with Python's standard library, split into bounded pages, and stored in the
  prepared-book library, so narration, bookmarks, progress, whole-book
  preparation, and export work without a PDF. Text books render as a
  transcript-style reading column; the library shows a source-kind badge.
- Prepared books can be exported as a **chaptered M4B audiobook**. New
  `POST /api/books/{id}/audiobooks` jobs concatenate one voice profile's
  prepared page audio into a single AAC `.m4b` with QuickTime chapter markers
  per page, using the bundled FFmpeg, and are downloaded once like archives.
- A **sleep timer** joins the shared playback transport: 5–60 minute presets
  or stop at end of page. The countdown pauses with playback and fires the
  normal stop path exactly once.
- Narration now registers with the browser **Media Session API**, so Windows
  media keys and the media overlay play/pause/stop, skip ±10 s, and move
  between pages while a book is narrated.
- `deploy/linux.md` and `scripts/setup_linux.sh` document a practical Linux
  server deployment: CPU or CUDA dependency profiles, frontend bundle
  rebuild, model placement (including the copy-from-Windows requirement for
  English Chatterbox weights), alignment-model staging, a hardened systemd
  unit, and a verification checklist.

### Fixed

- Importing an empty or unreadable EPUB/TXT no longer leaves a poisoned
  prepared-book entry that reported success on retry.
- The transcript is no longer a keyboard trap: words are one screen-reader
  flow, the transcript panel is a single tab stop with arrow-key word
  navigation, and past-word contrast meets WCAG AA.
- Narration no longer fails on CPU-only machines: the default guidance
  weight fell back to 0.0 on CPU builds, but the T3 model always runs the
  classifier-free-guidance batch of two, so every request died with a
  tensor-size mismatch before synthesizing a single sample. The default is
  now 0.4 on every device (the batch is paid either way; the weight only
  scales interpolation).
- Saving book progress no longer loses the race against concurrent reads on
  Windows: manifest writes retry briefly when a reader holds the file open,
  instead of failing the save with PermissionError.
- Opening a text book no longer refetches the current page forever: the
  reader's prefetch hook received a freshly-created callback on every render,
  which re-ran the page-restore effect in a loop (a network request roughly
  once a second) and kept the page column in its skeleton state.
- Restoring the window from the notification area no longer unmaximizes an
  already-visible window, repositions windows stranded on disconnected
  monitors into a usable area, and deterministically brings the existing
  window to the foreground.
- The startup splash is branded around the packaged BookVoice icon with real
  milestone text and a determinate progress bar; startup failures render a
  readable recovery screen with collapsed technical details.
- The packaged native reader route rendered `Play is not defined`; missing
  transport icon imports were restored.
- Default-voice seeding failures are now reported in the server log instead
  of being silently discarded.

## 2.3.0 - 2026-08-23

### Added

- A standalone **BookVoice-Launcher.exe** now ships with releases. Double-clicking
  it starts an installed BookVoice directly; on a fresh machine it first downloads
  and checksum-verifies the release payload, runs the per-user installer, and then
  starts the app. It replaces `BookVoice-Setup.exe`, which no longer ships.
  `--repair` forces a reinstall, `--machine` targets the all-users MSI with UAC,
  and every other argument is forwarded to the app untouched.
- The MSI writes a `Software\BookVoice\Install` registry value so the standalone
  launcher can locate the installation without probing.
- Release manifests include the launcher executable's size and SHA-256 next to
  the MSIs and cabinets; `SHA256SUMS.txt` covers it too.

### Changed

- The bootstrapper's download flow now reports per-file progress events and
  supports cancellation and resume hooks shared with the launcher's progress
  window; its release version is read from the build's bundled VERSION instead
  of a hardcoded constant that could reject fresh manifests.
- Release builds fail fast when `frontend/package.json` drifts from `VERSION`.
- The native Windows launcher now has a notification-area icon. Minimizing the
  window hides it from the taskbar while the backend and configured Cloudflare
  tunnel continue running; the icon restores BookVoice or shuts it down cleanly.
- Voice Studio microphone capture now preserves the browser's native sample
  rate instead of using a destructive nearest-neighbor conversion to 22.05 kHz,
  and requests an unprocessed mono 48 kHz signal where the device supports it.
- Saved voice profiles are explicitly global to the BookVoice host and remain
  available to every connected device, while Voice Studio projects and their
  media stay isolated to the device that owns them.
- Voice conversion now conditions on the most speech-dense target segment and
  gives the target speaker stronger decoder guidance, reducing leakage from the
  source speaker's vocal tone without changing the recording's timing.
- Microphone recordings created in Voice Studio now carry a 30-day expiration
  and are erased automatically. Imported media, generated outputs, and saved
  voice profiles are not part of this cleanup.

### Fixed

- Re-exporting a prepared book no longer overwrites the archive file an older
  export record still references; downloading that older archive can no longer
  delete a newer export's file.
- Saving a page of an unknown book answers `404 BOOK_NOT_FOUND` instead of
  `400 INVALID_PAGE`; Studio imports with a malformed project id answer
  `404 PROJECT_NOT_FOUND` instead of `INVALID_MEDIA`.
- Pressing Space while a button has focus activates that button instead of
  toggling narration playback.
- Toast notifications no longer re-trigger prepared-library refetches or restart
  voice-list polling loops (stable toast context identity).
- Voice profiles stranded by older install/version-scoped data directories are
  recovered into one stable machine library. Same-name recordings are preserved
  as dated variants instead of being overwritten; the original `Future` profile
  is restored while the newer attempt remains available separately.
- A failed Studio job no longer leaves its error banner visible after a newer
  job completes successfully.
- Phone recordings encoded as PCM WAVE_FORMAT_EXTENSIBLE no longer fail during
  waveform creation with `unknown format: 65534`.
- Studio and voice-profile atomic file commits now retry brief Windows sharing
  violations. This prevents otherwise successful conversions, including
  conversions to the preloaded Natasha voice, from being reported as failed
  when Windows momentarily holds `manifest.json`.
- The packaged Studio smoke now performs a real Natasha voice conversion and
  verifies the resulting output.

## 2.2.1 - 2026-07-28

### Fixed

- Voice Studio now accepts state-changing requests from its own browser-facing
  Cloudflare Tunnel origin, even when the internal FastAPI connection uses
  plain HTTP. Creating projects, importing media, cloning voices, and starting
  generation from a phone no longer fails with `Browser origin is not allowed`.
- Generated outputs use a real browser attachment download with the
  user-facing filename. **Download to this device** now transfers the file to
  the phone or computer using BookVoice instead of writing it into the host
  machine's Windows Downloads folder.
- Voice Studio's one-column phone layout now constrains media, output, and
  custom audio-player rows to the viewport. Generated output no longer creates
  horizontal overflow or lets adjacent review controls intercept download taps.
- Origin validation still rejects unrelated websites and records rejected
  origin/host pairs in the server log for diagnosis.

## 2.2.0 - 2026-07-28

### Changed

- Voice Studio projects now belong to the browser device that created them. Project metadata, copied source media, generated output, repair versions, downloads, and background jobs are hidden from every other device connected to the same BookVoice server.
- Projects created before device isolation remain on disk but start unassigned. Voice Studio offers an explicit one-time action to keep those earlier projects on the current device; once claimed, other devices cannot list or open them.

### Security

- Every Voice Studio project, job, and asset route now enforces an opaque per-device owner. Requests for another device's project return the same `404` response as an unknown project ID, and background media jobs retain the submitting device's scope.
- The browser's stable device identity is mirrored into a secure, HTTP-only asset cookie. Studio API requests repair a missing or stale cookie without putting the identity in media URLs.

## 2.1.3 - 2026-07-27

### Added

- Voice Studio adds a **Convert voice** workflow: import a recording and re-render it in another voice while keeping the original performance. Timing, rhythm, pauses, and emphasis come from the recording itself, so a delivery no longer has to be recreated by hand with the narration controls.
- The target voice for a conversion can be any saved voice profile or a 5–30 second selection taken straight from a second recording, without first saving it to the voice library.
- Long recordings are cut at natural pauses before conversion and reassembled with the original silences preserved, so a conversion stays aligned with the source instead of drifting.
- Voice conversion loads only the S3Gen decoder (~1 GB) when the narration model is not already resident, instead of pulling in the full ~3 GB stack. Conversion never uses the autoregressive T3 text decoder, so it stays usable on machines that cannot comfortably run narration — CPU-only laptops in particular.
- Cloning a voice from media now also derives matching pace, expression, and temperature from the recording's speaking rate and dynamic range, and applies them to the project automatically.

- BookVoice can now be hosted on a server. `BOOKVOICE_SERVER_MODE`, `BOOKVOICE_ACCESS_PASSWORD` and `BOOKVOICE_PUBLIC_ORIGIN` enable a password gate, trust the deployment's own browser origin, and replace the Windows-only file actions with a browser download. With none of them set the desktop app is unchanged.
- `deploy/modal_app.py` and `deploy/README.md` deploy the app to Modal, with model weights in a Volume so code changes do not rebuild three gigabytes.
- The tunnel can no longer adopt an unrelated cloudflared tunnel. `cloudflared` reads `~/.cloudflared/config.yml` by default and a `tunnel:` entry there overrides the name passed on the command line, so BookVoice would start someone else's tunnel and register a second connector on a service running on another machine — which Cloudflare then load-balances live traffic to. BookVoice now passes a config file of its own, and when given a tunnel UUID it verifies the ID cloudflared reports and refuses to continue on a mismatch.
- Tunnels created in the Cloudflare dashboard are supported via `--tunnel-token`. These take their ingress from Cloudflare and ignore `--url`, so `--port` pins the local port to match the dashboard's public hostname instead of scanning for a free one. The token is persisted for later launches and kept out of the launcher log.
- BookVoice can publish itself over Cloudflare Tunnel with a permanent HTTPS address. `--tunnel --tunnel-name <name> --tunnel-hostname <host>` is needed once; the settings persist, so later launches are just `--tunnel`, and the hostname survives reboots, app restarts, a new LAN address, and the backend landing on a different local port. The launcher starts and stops `cloudflared` with the app, trusts the tunnel hostname as an origin, and warns when a tunnel is running with no access password. `--tunnel` alone falls back to a quick tunnel, whose address changes every start.
- Because a tunnel provides real HTTPS, microphone recording works over it from a phone — it cannot work over a plain-HTTP local-network address.
- Voice Studio sessions are per device. Which project is open, which workflow tab you are on, and the draft script are kept in the browser rather than on the server, so opening BookVoice on a phone no longer drops you into whatever was left half-finished at the desk, on a tab you did not pick. Projects, voices, sources and outputs are still shared — they are the work.
- A device with no session of its own lands on a start screen that asks what you want to do, rather than auto-opening a project. Every project opens on Create narration, and an All projects action returns to the chooser.
- On a phone the workflow tabs no longer sit indented relative to the title bar above them.
- Audio playback is drawn by BookVoice rather than the browser. Safari renders native `<audio controls>` as an opaque dark slab that ignores the theme, which is why players appeared as black boxes on iPhone; an explicit black background on the audio elements made it worse. The new transport matches the app in both themes and exposes the underlying element, so region playback and looping still work.
- Recording now ends in a review step: play the take back, delete it, record another, or accept it. Previously a take was committed the moment you stopped, so a bad one had to be deleted afterwards. While recording, a live meter shows a scrolling history of input level instead of a single bar.
- Voice Studio can record straight from the microphone in both Convert Voice and the voice cloner, with a level meter and elapsed timer. Microphone access needs a secure context, so on a plain-HTTP local-network address the control explains why it is unavailable rather than failing when pressed.
- Importing media now selects the file that was just imported. Previously the picker stayed on the previous file, so a new upload looked like it had not arrived.
- The Voice Studio layout works properly on a phone: the project list collapses behind a summary instead of occupying the top of every screen, the page uses a single scroll container, sections and touch targets have room to breathe, and form fields are large enough that iOS does not zoom the page when one is focused.
- The desktop app can serve other devices on your network. `BookVoice.bat --host lan` (or `BOOKVOICE_HOST=lan`) binds beyond loopback, logs the addresses it is reachable at, and accepts browsers at private and link-local addresses; public hostnames are still refused. It defaults to `127.0.0.1` as before, and warns in the log when bound wider with no access password set.
- Generation can run off-process. `services/generation_gateway.py` is now the single dispatch point for narration, repair and conversion, and `services/remote_execution.py` lets a deployment register a worker to run them elsewhere. The Modal deployment uses this to serve the UI from a CPU container and spawn a GPU worker per job, so a browsing session no longer holds a GPU. With no executor registered the desktop app runs generation locally exactly as before.

### Changed

- Converted output is written as 16-bit PCM WAV, so it can be used directly as a source for waveform display and phrase repair.
- `GET /api/config/` now reports runtime capabilities, so the UI hides Save-to-Downloads and Open Folder where they cannot work instead of failing when used.

### Added

- Voice Studio adds persistent local projects for typed English/Arabic narration and waveform-guided audio or video phrase repair.
- Audio and video references can create reusable, consent-gated voice profiles with duration, loudness, clipping, silence, and sample-quality feedback.
- Studio narration includes pace, expression, temperature, guidance, and repeatable variation-seed controls, plus transcript-based sentence correction that creates a new immutable WAV version.
- Media repair preserves imported sources, creates loudness-matched and crossfaded WAV versions, and can remux repaired audio into a compatible MP4 without replacing the original video.
- Release payloads now include pinned FFmpeg and FFprobe 8.1.1 executables, checksums, and license notices in both runtime and release manifests.

### Fixed

- Phone layouts now use normal document scrolling instead of leaving the body
  locked while Voice Studio extends beyond the viewport, so every project,
  output, and action remains reachable.
- The app and Voice Studio mode selectors use compact, touch-friendly tabs on
  phones and tablets instead of wrapping desktop helper text into narrow
  columns.
- Each device now remembers its selected BookVoice workspace in addition to
  its active Voice Studio project, workflow, and draft.
- Remote voice-conversion jobs now carry portable shared-storage paths when
  dispatched from Windows, instead of sending backslashes to a Linux worker.
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
