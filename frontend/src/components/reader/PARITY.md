# Reader feature-parity matrix

> **Status — Phase 0.5 prep of `tasks/plan-bookvoice-improvements.md`.**
> This is the gate that authorises deleting `PdfViewer.jsx` (slice 0.5).
> Every row is either **closed** (with a verification artefact) or
> **deferred** (with a rationale and a CHANGELOG "Known limitation"
> entry). The matrix is signed off slice-by-slice; deletion is gated on
> every row being closed.
>
> **Superseded note (2.8.1, F-37).** Slice 0.5 shipped: `PdfViewer.jsx`
> is deleted. All `PdfViewer` references below are historical
> ("the pre-migration viewer").

## Conventions

- **Closed** = behaviour is present in the new reader and verified by a
  Vitest case (file + line range) or a documented manual checklist entry.
- **Deferred** = behaviour is missing from the new reader; the rationale
  explains why and where the user-visible impact is bounded.
- **Verification artefact** column links the reader to the test or
  checklist entry that proves the row.

## Parity rows

| # | Behaviour | Status | Verification | Notes |
|---|---|---|---|---|
| 1 | `?book=<id>` deep-link auto-open | **Closed** | `Reader.test.jsx` `auto-opens the prepared book referenced by ?book=<id>` + `does not auto-open when ?book=<id> does not match a library book`; mirrors `PdfViewer.jsx:237-242` | Desktop shell, `.bookvoice` double-click, addresses card all depend on this. |
| 2 | Saved voice + language from `useUserConfig` (apply-once) | **Closed** | `Reader.test.jsx` `applies saved voice and language from useUserConfig once it arrives`; pattern matches `configApply.test.js` | `useUserConfig` is the shared hook in `frontend/src/hooks/`. |
| 3 | Sleep timer (5/10/15/30/45/60 min + End of chapter) | **Closed** | `Reader.test.jsx` `exposes a sleep timer that arms and cancels` + `useSleepTimer.test.js` (87 lines, 6 cases) | Wired through `useSleepTimer`; `onExpire: narration.stopPlayback`; `notifyPageEnded` fires on `transportState === 'stopped'`. |
| 4 | Page-jump numeric input | **Closed** | `Reader.test.jsx` `jumps to a typed page number and clamps to the page count` | Toolbar `<form class="reader-page-jump">` submits typed page numbers and clamps them to `numPages` so an out-of-range entry lands on the last page rather than erroring. |
| 5 | OCR fallback for empty/scanned PDFs | **Deferred** | `CHANGELOG.md` "Unreleased" "Known limitations" | `usePdfDocument.preparePageText` returns text from the embedded PDF text layer; an OCR fallback for empty pages would require `EasyOCR` in the bundled runtime. The desktop shell is the only consumer that benefits, and EasyOCR is GPU-resident in `PdfViewer`'s path — keeping it server-only on the API surface. Users with scanned-only PDFs will see empty pages; a follow-up issue in `tasks/todo.md` will track adding `easyocr` to `requirements-ci.txt` and re-using it through the existing `/api/ocr` route. |
| 6 | Page-audio export to current page (WAV cache) | **Deferred** | `CHANGELOG.md` "Unreleased" "Known limitations" | `PdfViewer` calls `exportCachedAudio` (line 1894) to bundle pages 1…N into a downloadable ZIP. The new reader relies on the **book audiobook export** (`POST /api/books/{id}/audiobook`) for whole-book `.m4b` output, which subsumes the page-audio-cache export in scope but uses the chaptered M4B format. Users who need the per-page ZIP have no fallback reader; track as a follow-up. |
| 7 | Whole-book preparation + audiobook export | **Deferred** | `CHANGELOG.md` "Unreleased" "Known limitations" | Both flows live in `PdfViewer` (`PreparationProgress` UI + `handleExportAudiobook`). The backend endpoints (`/api/preparations`, `/api/books/{id}/audiobook`) already work; the missing piece is the reader UI. Voice Studio covers its own audiobook export surface. Tracking as a follow-up issue in `tasks/todo.md`. |
| 8 | Pronounce word on click while paused | **Deferred** | `CHANGELOG.md` "Unreleased" "Known limitations" | `PdfViewer` calls `pronounceText` for the clicked word. The new reader's narration pipeline (`useReaderNarration`) is unchanged from PdfViewer's port and the endpoint contract is the same; only the click-to-pronounce UI is missing. Word highlighting is deferred until cache entries carry real timings (per Reader.jsx comments). Tracking as a follow-up. |
| 9 | Follow-narration scroll lock | **Deferred** | `CHANGELOG.md` "Unreleased" "Known limitations" | `PdfViewer` writes `bookvoice.followNarration` to localStorage. The new reader renders text-book pages through `TextStage` and PDF pages through `PdfStage`; the auto-scroll behaviour on the speaking word needs both stages to know the active word. Word highlighting is deferred (row 8), so follow-scroll is moot for now. |
| 10 | Pan/drag when zoomed past viewport | **Deferred** | `CHANGELOG.md** "Unreleased" "Known limitations" | `PdfViewer` keeps a `panDragRef`. The new reader has CSS-zoom on `PdfStage` (fit-to-viewport width) which already wraps pages inside a scrollable container; users zoom by Ctrl/Cmd-wheel and scroll normally. A drag-to-pan would be a UX nicety, not a parity regression. |

## How to use this file

Each row has one of two outcomes:

1. **Closed** — link the test or checklist in the Verification column.
   When the row is closed, the deletion of `PdfViewer.jsx` may remove
   the legacy viewer's implementation of that behaviour without any
   user-visible change.
2. **Deferred** — leave the rationale in the Notes column. The matching
   `CHANGELOG.md` "Known limitations" entry must exist; without it, the
   row is not actually deferred, just unannounced.

When every row is closed or deferred, and the deferred rows all have a
matching CHANGELOG entry, slice 0.5 (delete `PdfViewer.jsx`) is
authorised. The PR description should reproduce the matrix and link this
file.

## Change policy

A new parity row must be added here when:
- a user-visible behaviour is removed from `Reader.jsx`, or
- a legacy viewer behaviour is newly discovered and not in the matrix.

A row can move from **Open** to **Closed** only with a Vitest case or a
manual checklist entry linked in Verification.
