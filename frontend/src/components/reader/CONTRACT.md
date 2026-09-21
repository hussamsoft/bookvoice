# Reader — public contract

> **Status — Phase 0.1 of `tasks/plan-bookvoice-improvements.md`.**
> This document is the source of truth for what `Reader` exposes, what its
> callers (`App.jsx`, tests) can rely on, and what gaps must close before
> slice 0.5 deletes `PdfViewer.jsx`.
>
> **Superseded note (2.8.1, F-37).** `PdfViewer.jsx` was deleted in the
> 2.7.x migration — every `PdfViewer` mention below is historical
> ("the pre-migration viewer"), and two rows have since changed: the
> `?book=` deep link now toasts when the id matches no library book
> (F-39), and `useUserConfig` is consumed by the Reader and shared
> app-wide through `UserConfigProvider` (F-33).

## 1. Export shape

```text
export default function Reader(): JSX.Element
```

The component takes **no props today**. Callers mount it as a lazy chunk:

```jsx
const Reader = lazy(() => import('./components/reader/Reader'));
…
<Reader key={`reader-${readerEpoch}`} />
```

The `key` is the only thing `App.jsx` ever changes; bumping `readerEpoch`
unconditionally remounts the component (used when the user opens a new book
or re-enters the reader from elsewhere).

## 2. Lifecycle contract

| Phase | Side effect | Caller-visible? |
|---|---|---|
| Mount | Reads `listPreparedBooks()` once via `usePreparedLibrary` and renders the empty state (file input + library rows). | Yes — library rows appear async. |
| Mount | Generates a `sessionId` via `createSessionId('reader')`. The session id is passed into `useReaderNarration` and travels through every narration request for cancel/by-key purposes. | Indirect — appears in network requests. |
| User selects a file | `handleFileChange` (PDF/archive imports through `importPreparedBook`; archives auto-open via `openLibraryBook`). | Yes — file input clears, status hint flashes. |
| User opens a library book | `openLibraryBook` resolves the prepared source and calls `activateBook`. | Yes — page 1 of the book appears (or saved page). |
| Activation | `activateBook` resets `pdfDocument`, clears `serverPages`, calls `narration.resetForNewBook`, hydrates `bookmarks`/`zoom`/`playbackRate` from `loadReadingProgress(documentId)`. | Yes — toolbar reflects saved state. |
| Page change (browse) | `lifecycle.browsePage` resolves content without auto-playing; updates URL is **not** touched. | Visible only as page text + counter. |
| Page change (load) | `lifecycle.loadPage` calls `onContent`, which sets `pageText`, fires `narration.startForLoadedPage` (autoplay by default), and writes freshly extracted PDF text back to `savePreparedPage`. | Visible as page text + audio plays. |
| Unmount | Native `wheel` listener is detached; debounced `updatePreparedProgress` timer is cleared. No pending narration is awaited (browser ref is gone). | None — `App.jsx` remounts via `key` change. |

**What `Reader` does NOT do today** (gaps to track for 0.5):

- Does **not** read `?book=` from `window.location.search` to auto-open a
  prepared book on mount. `PdfViewer` does this (lines 237-242). When 0.2
  flips the default, the App-level routing in `App.jsx:107-119` still passes
  `/?book=${id}` via `history.replaceState`, but the new Reader would need
  to mirror the auto-open behaviour to behave identically to the legacy
  viewer for desktop deep links and `.bookvoice` double-click.
- Does **not** read or apply `useUserConfig()` for voice/language. The
  server default voice is hard-coded (`useReaderNarration({ voiceId: null,
  languageId: 'en', … })`). `PdfViewer` reads `config.voice_id` and
  `config.language_id` via `useUserConfig`.
- Does **not** expose `onDirty` / `onExit` props. `App.jsx` does not pass
  them, and `PdfViewer` only uses them to drive the dirty-leave dialog (no
  equivalent exists in the new reader).

## 3. Hooks composed

Reader composes 13 hooks. The composition is the contract — replacing one
hook is a breaking change for any hook that consumes the same state.

### Reader-specific (`frontend/src/hooks/reader/`)

| Hook | Returned surface | Reader uses it for |
|---|---|---|
| `useBookmarks({ initial: [] })` | `{ bookmarks, toggle, set, isBookmarked }` | Toolbar button, `B` shortcut, progress save, restart-hydration |
| `useReaderZoom({ initial: 1 })` | `{ zoom, displayZoom, min, max, in, out, fit, set, onWheel }` | Toolbar zoom in/out/fit + non-passive wheel listener |
| `useReaderTransport(audioRef)` | `{ currentTime, playbackRate, setRate, skipBy }` | Skip-by-10s buttons + progress save + resume positioning |
| `usePreparedLibrary({ onError })` | `{ books, isLoading, refresh, setBooks }` | Empty-state library list, refresh after import |
| `useReaderPageLifecycle({ totalPages, resolveContent, onContent, onBeforeLoad, onError })` | `{ loadPage, browsePage }` | All page navigation, narration handoff, PDF text writeback |
| `useReaderNarration({ audioRef, transport, sessionId, voiceId, languageId, modelReady, getPage, onNarratePage, toast })` | `{ handlePlay, stopPlayback, toggleMute, resetForNewBook, transportState, audioPage, isGenerating, isPlaying, muted, startForLoadedPage, teardownForNavigation }` | All playback control; ref-bridged into the lifecycle for `onContent` |
| `usePageResume({ currentPage, audioPage, hasAudio, onResume, onStartFresh })` | `{ showChoice, resume, startFresh, dismiss }` | "Resume or start fresh?" dialog |
| `useReaderProgress({ documentId, page, time, zoom, playbackRate, bookmarks })` | side-effect only | Local autosave via `saveReadingProgress` |
| `useReaderSearch({ findInDocument, currentPage, totalPages })` | `{ result, isSearching, error, submit, reset }` | Find-in-book form, jump-to-page on match, status messages |
| `useServerPageText({ totalPages })` | `{ fetchPage, findText, clear }` | Text-book content + search |
| `useKeyboardShortcuts({ isEnabled, onToggleBookmark, onFind, onPrevPage, onNextPage, onFirstPage, onLastPage, onPlayPause, onSeekBack, onSeekForward, onToggleMute, onShowShortcuts })` | side-effect only | Global keydown dispatch |

### Shared (`frontend/src/hooks/`)

| Hook | Returned surface | Reader uses it for |
|---|---|---|
| `useToast()` | `{ info, success, error }` | Library load failure, page load error, progress-save failure, file open error |
| `usePdfDocument({ file, fileRef, toast })` | `{ adoptPdfDocument, preparePageText, findTextInDocument, resetDocument, … }` | PDF text extraction, in-document search, document lifecycle |
| `useTtsStatus()` | `{ modelReady, … }` | Wait for model ready before narration |

### Stage components

| Component | Props | Used when |
|---|---|---|
| `PdfStage` | `file, pageNumber, displayZoom, onDocumentLoad, onDocumentError` | `sourceKind === 'pdf'` |
| `TextStage` | `text, pageNumber, numPages, displayZoom` | `sourceKind !== 'pdf'` |

## 4. DOM contract

Reader publishes a few intentional attributes/refs that stylesheets and tests
can rely on. Once published, they are part of the contract.

### Root element

The reading surface (after a book is open) is a `<div>` with:

- `className="pdf-viewer-container"` — kept for CSS continuity with the
  legacy viewer's container class.
- `ref={rootRef}` — used for the non-passive `wheel` listener.
- `data-transport-state={narration.transportState}` — one of `idle |
  buffering | playing | paused | stopped`. The new reader and the test
  suite both depend on this attribute (e.g. `Reader.test.jsx:325-326`).
- `data-source-kind={sourceKind}` — `pdf | epub | txt | md | bookvoice`.

### Audio element

A single `<audio ref={audioRef} className="audio-hidden" preload="auto" />`
sits inside the root. Tests drive it via `container.querySelector('audio')`.

### Form controls by id / accessible name

The shortcut hook relies on these existing:

- `document.getElementById('reader-search-input')` — search input (focused by
  the `F` shortcut).
- Toolbar buttons are addressed by `getByRole('button', { name: … })` in
  tests. Their accessible names **are** the contract.

### Global lookups

- `window.HTMLMediaElement.prototype.play` / `pause` — tests stub these
  (`Reader.test.jsx:75-96`); Reader itself assumes a real browser media
  backend. Acceptable for the production build.

## 5. External dependencies

| Dependency | Purpose |
|---|---|
| `react-pdf` (`Document`, `Page`, `pdfjs`) | PDF rendering via `PdfStage` |
| `lucide-react` icons | Toolbar icons |
| `useToast` (shared) | Notification surface |
| `useTtsStatus` (shared) | TTS model readiness |
| `useUserConfig` (shared) | Saved voice/language, applied once (shipped in the migration; app-wide single copy via `UserConfigProvider`, 2.8.1 F-33) |
| `usePreparedLibrary`, `usePdfDocument`, `useServerPageText` | Data fetch |
| API helpers in `utils/api.js` | `importPreparedBook`, `preparedBookSource`, `getPreparedPage`, `savePreparedPage`, `updatePreparedProgress` |
| `utils/bookFiles.js` (`libraryBookFile`, `sourceKindFromName`) | Library row → file |
| `utils/pageContentResolver.js` (`resolvePageContent`) | Page text resolution |
| `utils/readingProgress.js` (`documentFingerprint`, `loadReadingProgress`) | Identity + restore |
| `utils/session.js` (`createSessionId`) | Per-session cancel token |

## 6. Open contract gaps (preconditions for slice 0.5)

Each row below is a behavioural difference between the two readers today.
Rows are flagged **Closed** when the new reader has the behaviour (with
the verifying test linked in `PARITY.md`), **Deferred** when the
behaviour is intentionally left to PdfViewer for one release, or
**Shipped** when the new reader does it natively without a direct
parity contract.

| Gap | Reader.jsx | PdfViewer.jsx | Status | Gate |
|---|---|---|---|---|
| `?book=` deep-link auto-open | shipped | `PdfViewer.jsx:237-242` | **Closed** | Vitest test on `Reader` |
| Saved voice + language from `useUserConfig` | shipped | `PdfViewer.jsx:104, 232-248` | **Closed** | Vitest test |
| OCR fallback for empty/scanned PDFs | absent | `PdfViewer.jsx` runs EasyOCR | **Deferred** | PARITY.md row 5 + CHANGELOG |
| Page-audio export (page → WAV cache) | absent | `PdfViewer.jsx:1894` | **Deferred** | PARITY.md row 6 + CHANGELOG |
| Whole-book preparation + audiobook export | absent | `PdfViewer.jsx` `PreparationProgress` | **Deferred** | PARITY.md row 7 + CHANGELOG |
| Pronounce word on click while paused | absent | `PdfViewer.jsx` `pronounceRef` + `pronounceText` | **Deferred** | PARITY.md row 8 + CHANGELOG |
| Sleep timer | shipped | `PdfViewer.jsx:148` + UI | **Closed** | Vitest test |
| Follow-narration scroll lock | absent | `PdfViewer.jsx:112-114, 229` | **Deferred** | PARITY.md row 9 + CHANGELOG |
| Page jump numeric input | shipped | `PdfViewer.jsx:109, 1244-1256` | **Closed** | Vitest test |
| Pan/drag when zoomed | absent | `PdfViewer.jsx:178` | **Deferred** | PARITY.md row 10 + CHANGELOG |

The closed rows were implemented in the 2.7.0 development cycle (PRs
that landed in commits `feat(reader): narrate pages behind ?reader=new`
and the reader rewrite chain). See `PARITY.md` for the Vitest case
references and `CHANGELOG.md` "Unreleased" for the deferred rows.

The reader's `useUserConfig` apply-once contract is preserved by
the dedicated apply-once effect at `Reader.jsx:225-234`. The sleep
timer is wired through the shared `useSleepTimer` hook at
`Reader.jsx:208-212`, with `onExpire: narration.stopPlayback` and
`notifyPageEnded` fired on the natural-end transport transition
(distinguishing natural end from user stop via `narration.naturalEndRef`,
audit L-4 fix).

## 7. Test surface

`Reader.test.jsx` (396 lines, 16 cases) covers:

- empty-state rendering
- library-book open with progress restore
- next/previous/keyboard navigation
- find-in-book jump + no-match state
- resume dialog after navigating away from the narrated page
- PDF file import + library record + `savePreparedPage` writeback
- bookmark toggle (B shortcut)
- server-side `updatePreparedProgress` mirror (debounced 3 s)
- streaming narration + chunk promotion to the canonical full-page WAV
- cancel-on-navigate via `cancelGeneration`
- prepared-audio resume parking at the saved position
- mute toggle
- Space shortcut → narration

These tests are the **current** contract. Adding new behaviour without
extending the test file is out-of-scope for refactor work.

## 8. Change policy

Any change to:

- the exported function signature
- the 13 composed hooks or the props passed into them
- the published DOM contract (root class, data attributes, audio element,
  accessible names of toolbar buttons)
- the file's load behaviour (`handleFileChange`, `activateBook`,
  `openLibraryBook`, `handleDocumentLoad`)

requires one of:

1. a corresponding test in `Reader.test.jsx` (or a sibling `*.test.jsx`),
   or
2. an update to this file explaining why the contract changed and which
   caller broke.

Reviewers should reject PRs that change Reader's surface silently.
