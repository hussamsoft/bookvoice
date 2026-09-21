# Phase 2 — Reader restoration

**Findings:** F-07, F-08, F-09, F-12, F-13, F-38 · **Risk: high** (largest
surface) · **Depends on:** Phase 1

This is the strategic phase. Everything here is **composition, not new
features** — the components already exist, already have tests, and are already
wired into `BookSession`. The Reader simply never picked them up when
`PdfViewer.jsx` was deleted.

Land each finding as its own commit so any one can be reverted alone.

---

## F-07 — The Reader lost most of the reading experience

`PlaybackControls.jsx` is a well-built transport: 44px play, scrubber,
elapsed/total, rate selector, sleep, stop/skip. Its docstring specifies
*"Primary row (≤4 visible elements)"*. Its line 52 comment references
*"PdfViewer wiring"* — the deleted component. It is reachable today only via
`NarrationPlayback` → `BookSession` (the scan flow).

| Capability | Where it lives | In Reader? |
|---|---|---|
| Scrubber + elapsed/total time | `PlaybackControls.jsx:154-170` | ✗ |
| Playback rate | `PlaybackControls.jsx:97-110` | ✗ — yet `activateBook` *restores* a saved rate (`Reader.jsx:437`) the user can never set |
| Word-level highlight sync | `Transcript.jsx`, `useWordHighlight.js` | ✗ |
| Transcript panel | `Transcript.jsx` | ✗ |
| Bookmark jump | `.bookmark-jump` (orphaned CSS) | ✗ — `reader-bookmark-count` renders "Bookmarks: 3, 7" as inert text |
| Voice / language picker | `VoiceSettings.jsx` | ✗ |

**Tasks**

- [ ] Render `<PlaybackControls>` in `Reader.jsx` in place of the inline
      play/stop/skip/mute/sleep cluster. Wire `transport`, `onStop`,
      `duration` (playlist-global), `onSeek`, `sleepRef`, `pageLabel`,
      `generating`.
- [ ] **Fix the prop contract while wiring it:** `PlaybackControls.jsx:169`
      renders `transport.duration` (current chunk) while the scrubber uses the
      `duration` prop (playlist-global). The scrubber sits at 50% while the
      clock reads "0:03 / 0:08". Make both read the same source.
- [ ] Delete the now-duplicated inline transport controls from
      `Reader.jsx:604-660`.
- [ ] Restore playback-rate control (comes free with `PlaybackControls`). Verify
      the rate restored by `activateBook` now round-trips.
- [ ] Make bookmarks navigable: replace the inert `.reader-bookmark-count`
      string with buttons that call `lifecycle.browsePage(n)`. `.bookmark-jump`
      styling already exists in `reader.css`.
- [ ] Add voice + language selection to the Reader via the existing
      `<VoiceSettings compact>`, wired the way `BookSession.jsx:59-77` does it —
      which also makes `userTouchedVoiceRef` / `userTouchedLanguageRef`
      (`Reader.jsx:94-95`) real instead of vestigial (closes part of F-37).

**Acceptance**

- The Reader shows a working scrubber whose position agrees with the clock.
- Playback rate is settable and survives a close/reopen.
- Clicking a bookmark navigates to that page.
- Changing voice/language in the Reader persists to config and applies to the
  next narrated page.

**Regression tests** — one per restored capability. The scrubber/clock
agreement test is the important one: assert both derive from the same duration.

---

## F-08 — An entire feature stack is orphaned

`useWordHighlight.js` has **zero consumers**. `pdfHighlight.js` is imported only
by it. `wordPronunciation.js` has zero consumers. All three ship with passing
test files. `PdfStage.jsx:89` still sets `renderTextLayer={true}` with the
comment *"the future highlight target"*.

**Decide explicitly — do not leave this ambiguous:**

- [ ] **Either** wire `useWordHighlight` into the Reader so narration highlights
      words on the PDF text layer and in `TextStage`, making
      `renderTextLayer={true}` earn its cost;
- [ ] **Or** delete `useWordHighlight.js`, `pdfHighlight.js`,
      `wordPronunciation.js` and their tests, set `renderTextLayer={false}`, and
      record the decision in `FINDINGS.md`.

Wiring it is the recommendation — word-sync is the app's signature feature and
currently only the scan flow has it. But a deliberate deletion is far better
than the current state, which pays the maintenance cost for zero user value.

**Acceptance** — either narration highlights words in the Reader, or the three
modules and their tests are gone and `renderTextLayer` is off.

---

## F-09 — No page-loading state in the Reader

`useReaderPageLifecycle` documents *"exposes `isLoading` so the consumer can
render a skeleton"* — `Reader.jsx` never destructures it (the only `isLoading`
there is the library's, line 148). Meanwhile `onBeforeLoad` does
`setPageText('')`, so **every page turn flashes "No text for page N yet."**
(`TextStage.jsx:11-13`) before content arrives — a false empty state on the
normal path.

**Tasks**

- [ ] Destructure `isLoading` from the lifecycle in `Reader.jsx`.
- [ ] Pass it to `TextStage` and `PdfStage`. `TextStage` renders
      `.skeleton--block` while loading and the empty state **only** when
      `!isLoading && !text`.
- [ ] Use the existing `.loading-waveform` / `.loading-progress` vocabulary
      (`controls.css:722-780`) rather than inventing another indicator — but
      see F-30, they need reduced-motion fallbacks.

**Acceptance** — turning a page shows a skeleton, never "No text for page N
yet." The empty state appears only for a genuinely empty page.

**Regression test** — render mid-load, assert the skeleton is present and the
empty-state copy is absent.

---

## F-12 — Text books render as one paragraph

`TextStage.jsx:22` — `<p>{text}</p>`. No `white-space: pre-wrap` on
`.text-page-column` (`reader.css:121-130`), no split on blank lines. **Every
paragraph break in every EPUB/TXT/MD book collapses to a single space.**

The typography around it is genuinely good — 68ch measure, Literata, 1.7
leading — wrapped around structureless content.

This also silently breaks the scan round-trip: `BookSession.jsx:172` joins
captured pages with `\n\n`, which then renders as one run.

**Tasks**

- [ ] Split the page text on blank-line boundaries and render one `<p>` per
      paragraph. Prefer this over `white-space: pre-wrap` — real paragraphs get
      correct margins, `text-indent` and selection behaviour.
- [ ] Add paragraph spacing to `.text-page-column p` in `reader.css`.
- [ ] Preserve intentional single newlines inside a paragraph (soft wrap) rather
      than turning them into hard breaks.

**Acceptance** — a multi-paragraph `.txt` book renders with visible paragraph
breaks; a scan session saved to Library and reopened shows its page boundaries.

**Regression test** — `TextStage.test.jsx`: given text with two blank-line
separated paragraphs, assert two `<p>` elements.

---

## F-13 — The toolbar contradicts the product's design thesis

`tokens.css` opens with a disciplined system — *"AURORA GLASS… color stays
rationed by meaning… ONE accent drives interactivity."* The Reader then puts
**~20 undifferentiated controls in one flat row**: bookmark, page status, prev,
next, page-jump, play, stop, −10s, +10s, mute, zoom−, zoom%, zoom+, fit, search,
sleep. No grouping, no separators, no hierarchy, no overflow.

For an app whose premise is calm immersive reading, this is a control panel
bolted above the page. The orphaned `.reader-nav-more` /
`.reader-nav-menu-group` / `.reading-options-popover` CSS shows a grouped,
progressively-disclosed toolbar *used to exist*.

**Tasks**

- [ ] Regroup into three zones: **navigation** (prev / page-jump / next),
      **transport** (the `PlaybackControls` component from F-07), and a
      **"More" popover** for zoom, fit, search, sleep and bookmarks.
- [ ] Reuse the existing `.reader-nav-more` / `.reader-nav-menu` /
      `.reader-nav-menu-group` styling rather than writing new CSS — it is
      already designed and already matches the token system.
- [ ] Give the popover the same keyboard contract you build for F-27 (focus
      moves in on open, Escape closes, focus returns to the trigger).
- [ ] Fix the bookmark button's label toggling between "Bookmark this page" and
      "Bookmarked" — it changes width and shifts every control to its right. Use
      a fixed-width label or an icon-only toggle with `aria-pressed`.

**Acceptance** — the Reader's primary row holds ≤6 controls; everything else is
one click away; nothing shifts position when state toggles.

---

## F-38 — "Try again" retries nothing

`Reader.jsx:735-745` — the `.reader-pdf-error` "Try again" button only calls
`setPdfLoadError(null)`. It is a dismiss button wearing a retry label. The same
failure is also reported twice: an inline error **and** a toast
(`handleDocumentError`).

**Tasks**

- [ ] Either make it re-attempt the load (re-key `PdfStage` to force a fresh
      `<Document>`), or relabel it "Dismiss".
- [ ] Report the failure once — keep the inline error, drop the toast.
- [ ] While here: the orphaned `.pdf-load-error-*` classes are a *designed*
      error state (icon / title / message). Consider adopting them instead of
      the plainer `.reader-pdf-error`, which will also reduce the Phase 6 sweep.

**Acceptance** — one error report per failure; the button does what it says.

---

## Exit gate

- [ ] F-07, F-08, F-09, F-12, F-13, F-38 marked `verified` in `FINDINGS.md`.
- [ ] F-08's decision (wire vs. delete) recorded in `FINDINGS.md` with a reason.
- [ ] Regression tests added per finding; each demonstrated failing first.
- [ ] Manual pass: open a PDF book and a text book, narrate a page, scrub, change
      rate, jump to a bookmark, search, turn pages. No console errors.
- [ ] Full verification suite green (`VERIFY.md`).
- [ ] `backend/static` rebuilt and committed.
- [ ] **Re-run the dead-CSS sweep** (`VERIFY.md` §4) and update the Phase 6 list —
      this phase revives several classes the review counted as dead.
