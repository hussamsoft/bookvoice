# BookVoice 2.0 architecture and UI rebuild

## Objective

Rebuild BookVoice as a reliable, offline-first Windows reading application. A
fresh install must open the reader without creating a virtual environment,
resolving Python dependencies, or downloading packages. The reader retains its
current PDF, camera/OCR, translation, voice, and narration capabilities while
receiving a new visual system designed for focused reading.

## Confirmed problem

The 1.10.1 installer ships an embeddable Python but creates the actual runtime
environment at first launch. Its unpinned transitive dependency solve currently
fails at `antlr4-python3-runtime` because the new venv does not contain
`wheel`. The backend never starts. This is a packaging architecture failure,
not a TTS error.

## Assumptions

- Retain the React reader and the FastAPI/Chatterbox engine; they contain the
  product behaviour worth keeping.
- Remain Windows-first and localhost-only.
- Ship a prebuilt Python 3.10 runtime environment with exact locked packages;
  no end-user `pip` invocation is allowed.
- Keep the existing native launcher for this migration, but reduce it to a
  small supervisor. A future native-shell replacement is deliberately outside
  this release rather than mixing another framework migration with the runtime
  rescue.
- Rebuild the UI around an ink-blue listening-room theme with parchment reading
  surfaces and copper playback accents.

## Target architecture

```text
Launcher.exe (small supervisor)
  -> verifies immutable runtime manifest
  -> starts bundled Python worker with an app-owned token and dynamic localhost port
  -> polls /api/health and /api/tts/status
  -> opens the React reader in the native shell

Bundled runtime (immutable)
  runtime/worker/python.exe + runtime/worker/Lib/site-packages/ + pinned manifest
  data/models/ + data/default_voices/

User data (mutable)
  %LOCALAPPDATA%/BookVoice/data, logs, session/config files
```

## UI direction

- **Subject and user:** a focused audiobook reader for people moving between a
  visual page and spoken narration. The primary job is to make the current
  reading state obvious without surrounding it with dashboard chrome.
- **Tokens:** Ink `#10263A`, Harbor `#1D4054`, Paper `#F5F1E8`, Graphite
  `#18212A`, Copper `#B86A3A`, and Signal `#BA3E45`.
- **Type:** `Fraunces`/Georgia for the book-facing display voice,
  `Source Sans 3`/system UI for controls and body text, and tabular system text
  for timers and page metadata.
- **Layout:** a compact top navigation rail, a reading stage, and a persistent
  playback/status dock. On wide screens the document and transcript share the
  stage; on small screens they stack in reading order.
- **Signature:** a slim vertical or horizontal "reading thread" that connects
  document position, current sentence, and playback progress rather than using
  decorative cards or gradients.

## Commands

- Frontend test: `npm test -- --run` from `frontend`
- Frontend build: `npm run build` from `frontend`
- Frontend lint: `npm run lint` from `frontend`
- Backend tests: `python -m pytest tests -q`
- Package build: `python build.py`
- Packaged smoke: `python scripts/smoke_launch.py --app-dir dist --skip-server`

## Success criteria

1. A packaged fresh-install smoke does not invoke `pip`, `uv`, or
   `setup_venv.bat`.
2. The runtime manifest declares the exact Python and package payload used by
   the launcher, and packaging tests fail if it is missing.
3. The launcher surfaces a concrete, logged runtime validation error instead
   of a generic setup failure.
4. The React reader renders the new visual system with no console errors,
   keyboard-visible focus, and a responsive document/transcript stage.
5. Existing reading, playback, camera, voice, and settings behaviour remains
   covered by the current tests; new runtime/UI behavior has regression tests.

## Boundaries

- Always: preserve user data, retain localhost binding, keep artifacts
  reproducible, and validate each slice before the next one.
- Ask first: changing the TTS provider/model family, adding cloud accounts,
  removing translation/OCR features, or switching the desktop shell framework.
- Never: download or resolve Python packages during end-user startup, place
  writable state under the install directory, or expose the API on the LAN.
