# Phase 3 — Responsive, touch, and layout

**Findings:** F-10, F-16 … F-21, F-41 · **Risk:** medium · **Depends on:** Phase 2

The app explicitly targets phones — `viewport-fit=cover`, `env(safe-area-inset-*)`
throughout, and "Open on another device" is a headline Settings feature that
serves this UI over LAN. The mobile path is currently the least correct one.

Run Phase 2 first: F-10 and F-16 both concern the transport bar, which Phase 2
puts into the Reader for the first time.

---

## F-10 — Mobile transport padding is on the wrong component

`reader.css:186-189` pads `.pdf-viewer-container` by ~92px at ≤720px to clear
the fixed transport bar. But `.pdf-viewer-container` is the **Reader's** root,
and (before Phase 2) the Reader never rendered `.playback-transport`.
`BookSession` — which *does* render it — uses `.book-session`, whose only rule
(`reader.css:1189`) has no bottom padding.

Net today: dead space at the bottom of the Reader on phones, occluded content in
the scan session.

**Tasks**

- [ ] Apply the `--transport-fixed-h` padding to whichever containers actually
      host a fixed transport after Phase 2 — at minimum `.book-session`.
- [ ] Better: scope it to a shared class (e.g. `.has-fixed-transport`) applied by
      the component that renders the bar, so the two can never drift again.
- [ ] `--transport-height: 76px` (`tokens.css:448`) has no consumers. Delete it
      or make `--transport-fixed-h` derive from it.

**Acceptance** — at ≤720px, neither surface has dead space and neither has
content hidden behind the bar. Scroll to the bottom of both and check.

---

## F-16 — Four different touch-target sizes, all claiming one standard

`controls.css:139-142` states the rule: *"every interactive control meets the
44px target that iOS HIG and Material set."* Actual outcomes on a phone:

| Selector | Result | Why |
|---|---|---|
| `.icon-btn`, `.btn` | 44px ✓ | `pointer: coarse` block |
| `.btn.btn-compact` | **36px** | `controls.css:673-674` (≤720px) comes *later* and wins — media queries add no specificity |
| `.btn.compact` | **28px** | `controls.css:122` `.btn.compact` (0,2,0) is never re-listed in either override; only `.btn.btn-compact` is |
| `.studio-transcript button` | **32px** | `studio.css:643-646` |
| `input[type=range]` (scrubber) | **28px** | not in the coarse list at all |
| `input[type=checkbox]` | **16px** | not in the coarse list |

The `.compact` case hits exactly the three controls you most want on a phone —
`PlaybackControls`' Stop / Back-10 / Forward-10 (`PlaybackControls.jsx:66,77,88`,
the only site using that alias).

`styles-parity.test.js`'s `ALLOWLIST` contains `'compact'` — which is precisely
what masks this.

**Tasks**

- [ ] Collapse the alias: pick `btn-compact` and rewrite the three `.compact`
      usages in `PlaybackControls.jsx`, then delete `'compact'` from the parity
      allowlist. One name, one rule, no drift.
- [ ] Reconcile the ≤720px override (36px) with the `pointer: coarse` rule
      (44px). Decide one number and make the comment true.
- [ ] Add `input[type=range]` (track hit area) and `input[type=checkbox]` to the
      `pointer: coarse` block.
- [ ] Raise `.studio-transcript button` to the same standard, or document why
      transcript word chips are exempt (they are inline text — a legitimate
      exception worth writing down).

**Acceptance** — a single documented touch-target value; every interactive
control meets it on a coarse pointer, or is listed as a deliberate exception.

---

## F-17 — The `Button` `size` prop does nothing

`.btn-sm` / `.btn-lg` are defined **only in `base.css`** (lines 184, 190), which
`main.jsx` imports *before* `controls.css`. `.btn` (same 0,1,0 specificity, later
file) then overrides `padding` and `font-size`, and its `min-height: 36px` beats
`.btn-sm`'s `height: 28px`.

`size="sm"` is fully inert (3 call sites — `SettingsView.jsx:217`,
`BookSession.jsx:216,284`); `size="lg"` gets its height but the wrong padding.

**Tasks**

- [ ] Move `.btn-sm` and `.btn-lg` out of `base.css` into `controls.css`,
      directly after `.btn`, as `.btn.btn-sm` / `.btn.btn-lg` compounds.
- [ ] Use `min-height` consistently (not `height`) so the coarse-pointer
      overrides in F-16 can still win.
- [ ] Visually confirm the three `size="sm"` call sites now render smaller —
      if they look wrong smaller, the call sites were written against the broken
      behaviour and should drop the prop instead.

**Acceptance** — `size="sm"` and `size="lg"` produce visibly different heights
from `md`.

**Regression test** — assert `.btn-sm` is declared in `controls.css`, not
`base.css`.

---

## F-18 — Frosted glass where nothing passes behind it

`.main-header` and `.sidebar` both carry
`backdrop-filter: saturate(1.5) blur(18px)`. Both are `flex: none` siblings of
`.main-content` — content scrolls *beside* and *below* them, never *under* them.
The blur samples only the static `.app-shell` gradient, producing a result a
solid colour would match, at the cost of two permanent compositor layers.

`.modal-overlay` **and** `.modal-panel` both blur (`controls.css:425,444`) — the
panel blurs an already-blurred backdrop through an 88%-opaque `--glass-strong`.
Two full-screen blur passes for a near-invisible difference.

**Tasks**

- [ ] Drop `backdrop-filter` from `.main-header` and `.sidebar`; keep
      `var(--glass)` or switch to a solid surface. Compare screenshots before and
      after — if there is no visible difference, the blur was pure cost.
- [ ] Drop `backdrop-filter` from `.modal-panel`, keep it on `.modal-overlay`.
- [ ] Keep blur where content genuinely scrolls behind (the fixed mobile
      transport, popovers over the page).

**Acceptance** — no visible regression; fewer compositor layers. This is a
performance fix on low-end GPUs and integrated graphics, which is where a
local-TTS app is already under load.

---

## F-19 — `100vh` on a phone-targeted app

`shell.css:5,20` — `.app-shell` and `.app-column` use `height: 100vh`, with
`body { overflow: hidden }`. With mobile dynamic browser toolbars, 100vh exceeds
the visible viewport and the bottom nav bar sits under browser chrome.

**Tasks**

- [ ] Switch to `100dvh` with a `100vh` fallback declaration first.
- [ ] Re-check the `env(safe-area-inset-bottom)` handling in `.sidebar`'s mobile
      block once the height is correct.

**Acceptance** — on a real phone browser (or device emulation with a dynamic
toolbar), the bottom nav is fully visible and tappable at rest and after scroll.

---

## F-20 — Toasts collide with the mobile bottom nav

`shell.css:762-773` — `.toast-region { position: fixed; bottom: var(--space-5) }`
= 24px, with no `env(safe-area-inset-bottom)`. At ≤720px the sidebar becomes a
~44px bottom bar at `bottom: 0`. Toasts render on top of Scan / Studio /
Settings.

**Tasks**

- [ ] At ≤720px, offset the toast region above the nav bar and any fixed
      transport: `bottom: calc(<nav height> + env(safe-area-inset-bottom) + var(--space-2))`.
- [ ] Derive the nav height from a token rather than hardcoding, so F-10's
      transport height and this stay in sync.
- [ ] `.toast-region-error` is orphaned — only one region renders
      (`Toast.jsx:137`). Delete it (also on the Phase 6 list).

**Acceptance** — at 390px width, a toast never covers a nav item or the
transport.

---

## F-21 — Library visual flatness and drifted duplicate markup

Every book is a text button with a 3-letter badge (`PreparedBookRow.jsx`). In an
app whose entire premise is books, the library has no visual anchor.

`.prepared-book-row` (`reader.css:1146`) never sets `cursor: pointer` — unlike
`.sidebar-item`, `.appearance-option` and `.step-track-button` — so the primary
row in the app does not signal clickability on hover.

The same row is hand-duplicated with drifted markup in `Reader.jsx:549-562`:
`<strong>` plus a page count instead of the progress line, and a raw lowercase
`"pdf"` badge instead of the mapped `"PDF"`.

**Tasks**

- [ ] Add `cursor: pointer` and `text-align: left` to `.prepared-book-row`.
- [ ] Replace the hand-rolled rows in `Reader.jsx:549-562` with the real
      `<PreparedBookRow>` component. One row component, one appearance.
- [ ] Truncate long titles (`text-overflow: ellipsis` on the title span, which
      already has `min-width: 0` on its parent).
- [ ] **Deferred, not this phase:** cover thumbnails. Tracked in `FINDINGS.md`
      as a feature.

**Acceptance** — the book row looks and behaves identically in Home, Library and
the Reader's open-a-book state.

---

## F-41 — Inconsistent loading treatment between sibling views

- `LibraryView` uses skeletons; `HomeView.jsx:126` puts a bare "Loading your
  library…" at the very **bottom**, after the action cards, while the thing
  loading is at the top — and its arrival pushes the cards down (layout shift).
- `LibraryView`'s add button renders the folder icon **and** a spinner
  simultaneously with an unchanged label; `HomeView`'s identical action shows no
  progress at all.
- `SettingsView` renders "Loading settings…" three times, each with
  `role="status"` — announced three times.

**Tasks**

- [ ] Give `HomeView` the same `.skeleton--book-row` treatment as `LibraryView`,
      reserving the continue-reading slot so nothing shifts.
- [ ] Unify the add-a-book button: swap the icon for the spinner (not both) and
      change the label to "Adding…". Apply to both views.
- [ ] Collapse Settings' three loading paragraphs into one, or gate the whole
      page on config with a single `role="status"`.

**Acceptance** — the two views look like they were designed together; no layout
shift when the library resolves; one loading announcement in Settings.

---

## Exit gate

- [ ] F-10, F-16 … F-21, F-41 marked `verified` in `FINDINGS.md`.
- [ ] Manual responsive pass at 1280 / 1024 / 820 / 768 / 390 px in light and
      dark, Reader + Library + Home + Settings + Scan.
- [ ] Touch-target audit: every interactive control meets the documented value
      or is a listed exception.
- [ ] Full verification suite green; `backend/static` rebuilt and committed.
