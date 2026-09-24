# Reader capability matrix

This matrix describes the production `Reader` rendered by the current app. It
does not describe a fallback mode. Reader consumes saved voice/language
configuration and now renders contextual controls for those values.

## Status vocabulary

- **Supported now** — the current UI renders and exercises the behavior.
- **Intentionally deferred** — the API or an adjacent surface may exist, but the
  Reader intentionally does not render this action.
- **Timing-dependent** — the UI must not claim the behavior until the active
  narration hook supplies trusted word timing/state.

## Capability matrix

| # | Capability | Status | Current surface | Verification / boundary |
|---|---|---|---|---|
| 1 | Open PDF, EPUB, TXT, MD, and `.bookvoice` books | **Supported now** | Reader open state and prepared-library rows | `Reader.test.jsx` covers prepared text/PDF opening and import writeback. |
| 2 | `?book=<id>` deep link | **Supported now** | Reader consumes the app-managed query parameter | `Reader.test.jsx` covers matching and missing ids. |
| 3 | Page navigation and numeric jump | **Supported now** | Previous, Next, page input | `Reader.test.jsx` covers button/keyboard navigation and clamping. |
| 4 | Bookmark toggle and jumps | **Supported now** | Toolbar bookmark plus More-options bookmark list | `Reader.test.jsx` covers bookmark shortcut and restored bookmarks. |
| 5 | Find in book | **Supported now** | More-options search form and status | `Reader.test.jsx` covers match, jump, no-match, and continued navigation. |
| 6 | Play/pause, stop, seek, time, speed, mute | **Supported now** | `PlaybackControls`; mute is in More | `Reader.test.jsx` and playback component tests cover the transport. |
| 7 | Sleep timer | **Supported now** | Minute presets and natural page-end stop | `Reader.test.jsx` plus `useSleepTimer.test.js`. The implementation stops on a natural page end; documentation must not call it chapter detection. |
| 8 | Streamed/prepared page narration | **Supported now** | Reader page playback | `Reader.test.jsx` covers streaming, cancellation, and prepared audio resume. `useReaderNarration.test.js` covers forwarding the prepared `bookId`. |
| 9 | Saved voice/language defaults and controls | **Supported now** | `VoiceSettings` plus English/Arabic language select in More | User changes persist through `useUserConfig`; `Reader.test.jsx` covers saved request values. |
| 10 | Reading progress and continue reading | **Supported now** | Local storage plus server mirror | Prepared books use `book.id`; only local uploads use `documentFingerprint`. Covered by `bookFiles.test.js` and Reader progress tests. |
| 11 | Prepare, save `.bookvoice`, export `.m4b` | **Supported now in Reader and Library** | `useBookActions` menus | Both surfaces use the same contract; `LibraryView.test.jsx` and Reader option coverage exercise the controls. |
| 12 | OCR for empty/scanned PDF pages | **Supported now, explicit only** | More → Run OCR for this page | `usePdfDocument` does not OCR implicitly; the explicit action uses the existing OCR path and can persist the page. |
| 13 | Click-to-pronounce a Reader word | **Supported now, measured-only for PDF** | Text words are keyboard/click buttons; PDF text-layer words activate when measured timings exist | Neural `/tts/pronounce` runs alongside narration; system voice is the independent fallback. |
| 14 | Per-page WAV/ZIP export | **Supported now** | `ReaderPageExport` in More; `createSinglePageDownload` and `buildPageAudioZip` | `exportCachedAudio` serves the prepared current page; range ZIPs contain page WAVs plus `manifest.json`. File downloads never overwrite playback or reading progress. |
| 15 | Leaving Reader with playback | **Supported now, explicit disabled state** | Other views show disabled Return to book | Reader unmount stops its only audio element; no second playback session is fabricated. |
| 16 | Pan/drag and automatic page turn | **Intentionally deferred** | Zoom/fit and explicit navigation only | Do not infer these actions from dormant helpers. |
| 17 | Measured text-book and PDF word highlighting | **Supported now when backend supplies it** | `TextStage` and `PdfStage` mark `useReaderNarration.currentWord` | Complete monotonic timing maps only; PDF spans rebind after page changes. |
| 18 | Follow-narration auto-scroll | **Supported now for both stages when timings exist** | Persistent checkbox in More | Uses the stage's measured highlight; PDF is disabled with an explanation when its page lacks timings. |

## Claim rules

1. Use the exact Reader symbols listed in `CONTRACT.md`; dormant hooks and
   backend endpoints are not shipped UI.
2. Do not describe `TextStage` as an interactive transcript. It renders text
   pages and marks only a measured active word.
3. Saved configuration and Reader controls are distinct contracts; both are
   allowed to be present when the control is rendered and persisted.
4. Keep Reader and Library book-action surfaces named explicitly.
5. A deferred or timing-dependent row may move to **Supported now** only in the
   same change that renders it and adds a focused behavioral test.
