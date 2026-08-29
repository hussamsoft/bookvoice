# BookVoice 2.6.1 — Testing Guide

Patch release fixing runtime-breaking missing-import crashes in the reader and
audiobook export flows, plus lint and dead-code cleanup. Version bumped from
2.6.0 → 2.6.1.

## What changed

- **Critical**: PdfViewer.jsx missing icon imports (`Pause`, `Play`, `Download`)
  and missing util imports (`getBookAudiobook`, `shouldAdoptPreparedProfile`,
  `activePreparedProfile`, `preparedBookDetails`, `normalizePronunciationText`,
  `pronounceWithSystemVoice`, `stopSystemPronunciation`,
  `preparedPageAudioEntry`, `resolvePageContent`) that crashed the reader on
  mount and the audiobook export flow during polling.
- Fixed `VERSION` file (was `2.5.0`) to match `frontend.package.json` and
  CHANGELOG (`2.6.1`).
- Removed unused imports and fixed empty-catch / exhaustive-deps lint
  diagnostics across App.jsx, CameraCapture.jsx, NarrationPlayback.jsx,
  Toast.jsx, Transcript.test.jsx, VoiceSettings.jsx.

## Build verification (already run)

- Frontend unit: **251/251 passing**
- Frontend lint: **0 diagnostics**
- Frontend build: **entry 225.02 kB (70.88 kB gzipped)**
- Backend pytest: **129 passed** (1 dist-dependent skip)
- Simulation journeys: **49 passed / 4 failed** (failures are FFmpeg-dependent
  media-import paths — pre-existing environmental limitation, not regressions).

## Testing artifact

- `dist/BookVoice-Dev.exe` (26 MB) — development launcher using system Python.
  Double-click to start BookVoice. No installer, no venv, no separate setup.
- `dist/BookVoice.exe` (244 MB) — full portable launcher (embedded Python
  worker + pinned FFmpeg). This is the functionally-equivalent release build;
  FFmpeg is a GPL binary staged from a separate source.

## Install / run

1. Take `dist/BookVoice-Dev.exe` (or `BookVoice.exe`).
2. Double-click. On first run the launcher shows a splash; narration becomes
   available once the status area reads "Model ready on CPU/CUDA".
3. The default mode is **Read**. Open the app window.

## Areas to test

Run these against the built EXE. Each block is independent.

### 1. Reader — PDF (verify the fixed imports)
1. Click **Select PDF Book** and pick any PDF.
2. The PDF renders in the left pane; the transcript column appears on the
   right.
3. Press **Play** in the narration transport — the button icon must be
   visible (Play/Pause icons now render; they were blank before the fix).
4. With audio on the current page, the **Download page audio** button
   (bottom toolbar) must be visible and clickable.
5. Click a word in the transcript — playback jumps to that word.
6. Use transport controls: play/pause, seek slider, skip ±10 s, speed
   selector (0.75x–2x). Highlight follows.
7. Page navigation: click the page input, type a number, Enter — page
   changes, clamped to `[1, numPages]`.
8. Ctrl+wheel zooms; plain wheel scrolls; Ctrl+drag pans.
9. Bookmarks via the overflow menu (chevron) — toggle, list, jump.
10. Progress restores after close/reopen.

### 2. Reader — EPUB / Text
1. Upload a `.txt`, `.md`, or `.epub`.
2. Transcript column renders the text instead of a PDF pane.
3. Play narration — word highlighting works.
4. Reopen — the book appears in the prepared library with the correct
   source-kind badge.

### 3. Whole-Book Preparation
1. Open a book with >= 3 pages.
2. Click **Prepare whole book** — a progress indicator shows on the card.
3. Wait for `COMPLETED` (CPU can take minutes; polls every 5 s).
4. Cancel mid-way — status becomes `CANCELLED`, completed pages remain.
5. Resume — picks up from the first un-prepared page.

### 4. Archive Export
1. Open a fully prepared book.
2. Click **Export archive** (`.bookvoice`) — 201 creates a record.
3. Download the file — first 4 bytes are `PK\x03\x04` (valid ZIP).

### 5. Audiobook Export (verify the getBookAudiobook fix)
1. Open a fully prepared book.
2. Click **Export audiobook** — an export job starts.
3. Wait for settlement. The polling callback now reads status without a
   `ReferenceError: getBookAudiobook is not defined` crash (previously the
   export flow died here).
4. A download URL appears — click to download the `.m4b`.
5. Open in a media player — it plays, has per-page chapter markers.

### 6. Voice Studio — Create Narration
1. Switch to **Voice Studio** mode.
2. Click **Create narration** — a new project opens.
3. Type a short script, click **Generate** — a narration job starts.
4. Wait for `succeeded` — audio player and transcript appear.
5. Click a word in the transcript — playback jumps.
6. Select a word, edit the sentence, click **Create corrected version**.

### 7. Voice Studio — Voice Cloning
1. **Voice Cloner** tab — check consent.
2. Upload a `.wav` — the voice appears in the selector.
3. Non-WAV rejection: try an MP3 — toast rejects it.
4. Consent resets after successful upload.
5. Delete via trash icon — ConfirmDialog appears (not `window.confirm`).

### 8. Settings & Themes
1. Default mode is light (`data-mode="light"`).
2. Moon/sun icon toggles light/dark.
3. Palette selector — 5 palettes × 2 modes = 10 combinations.
4. Keyboard navigation in the palette dropdown: Arrow Down moves through
   options, Enter/Space selects, Escape closes.
5. AudioPlayer seek slider: screen reader announces current time as
   `aria-valuetext`; Arrow Left/Right seeks.
6. Palette + mode persist across restarts (`bookvoice.palette`,
   `bookvoice.mode` in localStorage).

### 9. Error Handling
1. Upload a non-PDF renamed to `.pdf` — user-friendly error panel with
   **Try again**.
2. Password-protected PDF — specific message.
3. Broken audio file — `onError` callback fires, toast with error type,
   transport resets to safe state.

### 10. Accessibility
1. Tab through the reader toolbar — every control reachable, focus rings
   visible.
2. Reading Options popover — focus moves to first control, Escape closes
   and returns focus to trigger.
3. Modals — `aria-labelledby` points to `<h2>`, focus trapped, body scroll
   locked.
4. Mode buttons use `role="tab"` + `aria-selected`; arrows/Home/End move.
5. Toasts in polite live region; errors in assertive region.

### 11. Cross-Mode State
1. Switch Read → Scan → Studio — no React state-update-on-unmount warnings,
   no phantom toasts.
2. Start narration in Scan, switch to Read — stale promise resolves
   silently.

## Pass criteria

- All steps execute without console errors or uncaught exceptions.
- Play/Pause/Download icons render (not blank).
- No `ReferenceError` in the console during reader load or audiobook export.
- All 10 theme combinations render with WCAG AA contrast.
- No hardcoded hex colors in stylesheets.

## Known limitations

- Voice Studio media import (J3, J7) requires FFmpeg to transcode uploads;
  without it, import jobs fail. This is a pre-existing environmental
  dependency, not a regression. The desktop release ships pinned FFmpeg
  8.1.1 in `tools/ffmpeg`.
- Audiobook export download also requires FFmpeg for M4B muxing.
- Themes: the `data-palette` / `data-mode` system relies on localStorage;
  clearing site data resets to the Paper Slate / light default.

## Reporting failures

Report: OS, BookVoice version (`dist/VERSION`), the failing step number,
console output (DevTools → Console), and whether FFmpeg is available on
PATH.
