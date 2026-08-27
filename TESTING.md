# BookVoice Manual Testing Guide

Step-by-step functional and UI checks for a release. Run these by hand against a fresh `dist/` build (or the packaged MSI install). Each block is independent; run them in any order.

## Setup

1. Start BookVoice from `dist/BookVoice-Dev.exe` (or the installed app).
2. Wait for the launcher to show "Model ready on CPU/CUDA" in the status area — the TTS model loads asynchronously on startup; narration is unavailable until it finishes.
3. Open the app window. The default mode is **Read**.


---

## 1. Reader — PDF
1. Click **Select PDF Book** and pick `tests/fixtures/english.pdf` (or any PDF).
2. The PDF renders in the left pane; the transcript column appears on the right.
3. Press **Play** in the narration transport — audio starts, the current word highlights in both the PDF text layer and the transcript.
4. Click a word in the transcript — playback jumps to that word and resumes.
5. Use the transport: play/pause, seek slider, skip ±10 s, speed selector (0.75x–2x). Each control works and the highlight follows.
6. Test page navigation: click the page input, type a page number, press Enter — the page changes. The input clamps to `[1, numPages]`.
7. Test Ctrl+wheel zoom: the PDF scales. Plain wheel scrolls the page vertically.
8. Test Ctrl+drag pan: the page pans; releasing leaves it where you dropped it.
9. Test bookmarks: click the "More reader actions" overflow menu (chevron icon) on the toolbar, then click the bookmark toggle — it toggles. Open the bookmark list, click a bookmark — jumps to that page.
10. Test progress: close and reopen the book — it restores the last page and position.
11. Test follow-narration: the "Follow" toggle on — narrated page changes automatically. Click a different page manually — Follow turns off (no disruptive jump back).

## 2. Reader — EPUB / Text

1. Open the reader, upload `tests/fixtures/sample.txt` (or `.epub`, `.md`).
2. The transcript column renders the text instead of a PDF pane.
3. Play narration — word highlighting works the same as PDF.
4. Page through the chapter — pages load from the server cache.
5. Close and reopen — the book appears in the prepared library with the correct source-kind badge.

## 3. Whole-Book Preparation

1. Open any book with ≥ 3 pages (a multi-page PDF or a text file).
2. Click the **Prepare whole book** button (or the reading-options equivalent).
3. A preparation job starts — a progress indicator shows on the book card in the library.
4. Wait for status to reach `COMPLETED` (CPU can take minutes; the job polls every 5 s).
5. Cancel a running preparation mid-way: click **Cancel** — status becomes `CANCELLED`, completed pages remain.
6. Resume: start preparation again — it picks up from the first un-prepared page.
7. Once COMPLETED, every page plays immediately without re-generating.

## 4. Audiobook Export

1. Open a fully prepared book.
2. Click **Export audiobook** (or the reading-options equivalent).
3. An export job starts — wait for it to settle (status in `JOB_DONE`).
4. A download URL appears. Click it — the `.m4b` file downloads.
5. Open the file in a media player — it plays, has chapter markers per page, and the first bytes are `ftyp` (valid MP4/M4B container).

## 5. Archive Export

1. Open a fully prepared book.
2. Click **Export archive** (`.bookvoice`).
3. A `201` response creates an archive record; the status becomes `COMPLETED` within 30 s.
4. Click the download link — the `.bookvoice` file downloads.
5. The first 4 bytes are `PK\x03\x04` (valid ZIP). (Optional) unzip it — `manifest.json`, `document/source.pdf`, `pages/*.json`, and `audio/<profile>/*.wav` are present.

## 6. Voice Studio — Create Narration

1. Switch to **Voice Studio** mode.
2. Click **Create narration** — a new project opens.
3. Type a short script (or paste one) in the text editor.
4. Click **Generate** — a narration job starts.
5. Wait for status to reach `succeeded` — an audio player and transcript appear.
6. Click a word in the transcript — playback jumps there.
7. Test sentence correction: select a word, the sentence containing it loads into an editor. Edit the text, click **Create corrected version** — a new output is generated.

## 7. Voice Studio — Voice Cloning

1. In Voice Studio, go to the **Voice Cloner** tab.
2. Check the consent box ("I own or have permission to clone this voice").
3. Option A — Record: click **Record**, speak for 3+ seconds, click **Stop & save**. The recording uploads, a voice profile is created, and it becomes the active voice.
4. Option B — Upload: enter a name, click **Upload .wav**, pick a WAV file. The upload completes and the voice appears in the selector.
5. Test non-WAV rejection: try uploading an MP3 — a toast rejects it with "Please upload a WAV file."
6. Test consent reset: after a successful upload/record, the consent checkbox is now unchecked (must re-affirm for the next one).
7. Test delete: click the trash icon on a voice — a ConfirmDialog appears (not `window.confirm`). Confirm — the voice is removed and the selector clears.

## 8. Voice Studio — Convert Voice

1. In Voice Studio, go to the **Convert voice** tab.
2. Import a source recording (WAV with speech).
3. Select a target voice from the dropdown (one you created in step 7).
4. Click **Convert** — a conversion job runs.
5. Wait for completion — the converted audio plays back.
6. Download the output — it's a valid WAV.

## 9. Voice Studio — Phrase Repair

1. Open a narration output with word timings.
2. Click a word — the sentence loads.
3. Edit the text, click **Create corrected version**.
4. A new output is generated with the repaired audio.

## 10. Settings & Theme

1. Open Settings (gear icon in the title bar).
2. The gear is stable during config loading — it doesn't flash in/out (it renders a disabled placeholder until config resolves).
3. The settings panel opens on click, closes when clicking outside — focus returns to the gear button.
4. The gear's `aria-label` toggles between "Open settings" and "Close settings".
5. Toggle the dark/light theme button — the entire app rethemes immediately (both light and dark modes render correctly with warm paper / warm dark paper).
6. Test that all semantic tokens resolve: no hardcoded `#f7f5f1` or `#161513` remains in the stylesheets (check via the styles-parity test).

## 11. Error Handling — PDF

1. Open the reader, upload a non-PDF file renamed to `.pdf` — the `onLoadError` handler shows a user-friendly error panel: "Failed to load PDF: …" with a **Try again** button.
2. (If you have a password-protected PDF) upload it — the message reads "This PDF is password-protected and cannot be opened."
3. Click **Try again** — the error clears, and the book can be re-selected.

## 12. Error Handling — Audio

1. Open a narration output with a missing/broken audio file (simulate by deleting the generated WAV mid-session).
2. The `onError` callback fires on the `<audio>` element — a toast appears with the error type (`MEDIA_ERR_DECODE`, `MEDIA_ERR_NETWORK`, or `MEDIA_ERR_SRC_NOT_SUPPORTED`).
3. The transport resets to a safe state (no infinite spinner).

## 13. Accessibility — Focus & Keyboard

1. Tab through the reader toolbar — every control is reachable, focus rings are visible.
2. Open Reading Options (popover on desktop) — focus moves to the first interactive control inside. Tab cycles within the panel; Escape closes it and returns focus to the trigger.
3. Open a modal dialog (ConfirmDialog, settings dropdown) — `aria-labelledby` points to the visible `<h2>`. Focus is trapped inside; Tab wraps at the edges. Escape closes and returns focus to the trigger.
4. The mode buttons (Read / Scan / Studio) use `role="tab"` with `aria-selected` on the active one, not `aria-current="page"`. Arrow keys move between tabs; Home/End jump to first/last.

5. Toast notifications appear in a polite live region; errors appear in an assertive region. Both are announced without re-triggering fetches or polling loops.

## 14. Touch Targets (Coarse Pointer)

This is hard to test on a desktop; verify via code review or by resizing to a phone viewport:
1. In `@media (pointer: coarse)`, `.icon-btn` is 44×44 px (check in DevTools computed styles).
2. `.audio-transport-toggle` is 44×44 px.
3. `.btn.compact` min-height is `--control-h-lg` (44px).

## 15. Media Session & System

1. Start narration — the Windows media overlay / system media keys (Play/Pause, Skip ±10 s) control BookVoice playback.
2. Minimize the main window — the notification-area icon remains. Click it to restore.
3. Close the visible window — the backend keeps running if a tunnel is configured; otherwise the app exits.

## 16. Cross-Mode State

1. Switch between **Read a book** → **Scan a page** → **Voice Studio** — no React state-update-on-unmount warnings in the console, no phantom toasts.
2. Start a narration in Scan mode, then immediately switch to Read mode — the narration promise resolves silently (no stale `setStep`/`toast` on the unmounted component).

---

## Pass Criteria

- All steps execute without console errors or uncaught exceptions.
- All toasts are meaningful and in the correct region.
- All focus changes are visible and sensible.
- Both light and dark themes render with full contrast (WCAG AA on text).
- No hardcoded hex colors remain in the stylesheets.
- All 60 simulation journeys pass (`python scripts/simulate_app.py`).
