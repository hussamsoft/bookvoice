# Reader — current public contract

`Reader` is the production reading surface. It is mounted as a lazy component by
`App.jsx`; there is no alternate reader mode or query-parameter switch.

## Capability status

| Status | Capability | Current contract |
|---|---|---|
| **Supported now** | Open books | `Choose a book file` accepts PDF, EPUB, TXT, MD, and `.bookvoice`; prepared-library rows open the same books. `?book=<id>` auto-opens a matching prepared book. |
| **Supported now** | Navigate, find, and contextual options | The toolbar renders bookmark, Previous, Next, page jump, and More. More contains mute, zoom out/in, Fit, find-in-book, bookmark jumps, `VoiceSettings`, supported English/Arabic language selection, Follow narration, explicit PDF OCR, and book actions. |
| **Supported now** | Narration transport | `PlaybackControls` renders play/pause, stop, seek, elapsed/remaining time, playback speed, and sleep-timer presets. Pages use streamed TTS and prepared page audio when available. |
| **Supported now** | Reading state | Page, time, zoom, speed, and bookmarks persist locally. Prepared books use the stable server `book.id`; server-side progress mirrors to the Library. |
| **Supported now** | Whole-book actions | Reader and Library both use `useBookActions` to prepare a book, save `.bookvoice`, and export `.m4b`. |
| **Supported now, measured only** | Word state and highlighting | `useReaderNarration` exposes a current word only for a complete monotonic timing map. `TextStage` and `PdfStage` highlight measured words; PDF spans rebind after page changes. |
| **Supported now, explicit action** | Scanned-PDF OCR | Reader extracts the embedded text layer without implicit OCR. More exposes **Run OCR for this page**, which uses the existing `usePdfDocument`/OCR path and persists the result when a book id exists. |
| **Supported now, no second transport** | Leaving Reader | Reader's existing playback stops on unmount; other views show a disabled **Return to book** state instead of a second audio state machine. |
| **Supported now, measured-only for PDF** | Click-to-pronounce | Text words are buttons activated by click, Enter, or Space. Neural pronunciation runs alongside narration; the OS voice is the fallback. PDF text-layer activation requires measured timings. |
| **Supported now** | Per-page WAV/ZIP export | `ReaderPageExport` uses `exportCachedAudio` for the current prepared page and `pageAudioZip.js` for inclusive-range STORE-only ZIPs with `manifest.json`. It downloads through anchor elements and never overwrites narration transport or reading progress. |
| **Intentionally deferred** | Pan/drag and auto-turn | Reader supports zoom/fit and page controls, not drag-to-pan or automatic page turn. |
| **Supported now, measured only** | Follow-narration auto-scroll | The persistent checkbox follows the measured active word in both stages; PDF is disabled with an explanation when the current page lacks timings. |

## Export and mount shape

```text
export default function Reader(): JSX.Element
```

`Reader` takes no props. `App.jsx` mounts it without a prop contract:

```jsx
const Reader = lazy(() => import('./components/reader/Reader'));
<Reader key={`reader-${readerEpoch}`} />
```

Changing `readerEpoch` remounts the surface when a book is opened.

## Lifecycle contract

| Phase | Side effect | Caller-visible result |
|---|---|---|
| Mount | Loads the prepared library and creates a Reader session id. | The open-book surface lists prepared books. |
| Open prepared book | Resolves a PDF source when needed, chooses the server `book.id` as local-progress identity, resets narration, and restores progress. | The book title, page, zoom, speed, and bookmarks render. |
| Open local upload | Uses the browser file fingerprint for local progress and imports the file into the library when required. | The file opens; its library record may arrive asynchronously. |
| Browse page | Resolves prepared/server/PDF text without starting new narration. | Page text, search state, and page count update. |
| Start narration | `useReaderNarration` first uses prepared page audio, then its page cache, then streamed generation. Prepared generation includes the active `book.id` so successful audio can be promoted by the backend. | Playback starts or reports a real error. |
| Page change for narration | Aborts/cancels in-flight work before the next page resolves. | Playback transitions to the new page. |
| Unmount | Cancels narration and flushes pending prepared-book progress. | No reader-owned work survives the remount. |

## Composed hooks

| Hook | Reader responsibility |
|---|---|
| `usePreparedLibrary` | Open-book list and progress updates. |
| `usePdfDocument` | PDF document lifecycle, text extraction, and search. |
| `useServerPageText` | Text-book page loading and search. |
| `useReaderPageLifecycle` | Browse/load distinction and page race cancellation. |
| `useReaderNarration` | Prepared/cache/stream ladder and playback events. |
| `useReaderTransport` | Shared play, pause, seek, rate, time, and duration. |
| `useReaderProgress` | Local progress autosave. |
| `useUserConfig` + `VoiceSettings` | Saved defaults plus contextual voice selection; Reader persists user changes. |
| `useBookActions` | Prepare, archive, and audiobook actions for the active prepared book. |
| `useSleepTimer` | Minute timer and natural page-end stop. |
| `useBookmarks` | Toggle, jump, display, and persistence. |
| `useReaderSearch` | Wrap-around find-in-book state. |
| `useReaderZoom` | Zoom in/out/fit and wheel behavior. |
| `useKeyboardShortcuts` | Navigation, playback, seek, mute, find, and bookmark keys. |
| `usePopoverMenu` | More-options keyboard/outside-click behavior. |
| `useUserConfig` | Apply saved voice and language once. |
| `useTtsStatus` | Model-readiness gate. |
| `useToast` | User-visible failures. |

## DOM contract

### Reading root

After a file opens, the root remains:

```html
<div
  class="pdf-viewer-container"
  data-transport-state="idle|buffering|playing|paused|stopped"
  data-source-kind="pdf|epub|txt|md"
>
```

It owns one hidden audio element:

```html
<audio class="audio-hidden" preload="auto" />
```

The open-book state uses the same root class and contains the accessible
`Choose a book file` input plus prepared-book rows.

### Stable controls and ids

- `reader-upload` — book file input.
- `reader-page-jump-input` — numeric page jump.
- `reader-search-input` — find-in-book input focused by `F`.
- Accessible buttons/controls include Previous, Next, More options, bookmark,
  mute, zoom out/in, Fit, Search, playback transport, narration position,
  narration speed, and sleep timer.

## Data identity and dependencies

| Dependency | Purpose |
|---|---|
| `utils/bookFiles.js` | Source-kind detection, prepared render adapter, and `readerProgressId`. |
| `utils/readingProgress.js` | Local progress storage and local-file fingerprint fallback. |
| `utils/pageContentResolver.js` | Prepared/server/PDF page-text ladder. |
| `utils/api.js` | Import, page, progress, and narration requests. |
| `useUserConfig` + `VoiceSettings` | Saved defaults plus contextual voice/language selection and persistence. |
| `react-pdf` | PDF rendering. |

## Verification surface

Focused contracts are covered by:

- `Reader.test.jsx` — open/deep-link, navigation, search, bookmarks, progress,
  playback, and prepared-page narration behavior.
- `useReaderNarration.test.js` — playback stop semantics and prepared `bookId`
  forwarding.
- `bookFiles.test.js` — server-id versus local-file progress identity.
- `UpdateBanner.test.jsx` — updater reachability is app-owned; install still
  requires confirmation.

A change to the no-props export, root/data attributes, stable control names,
or capability table must update this file and its focused test in the same
change.
