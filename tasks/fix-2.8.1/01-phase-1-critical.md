# Phase 1 — Critical correctness

**Findings:** F-01 … F-06, F-14, F-15 · **Risk:** low · **Depends on:** nothing

Eight surgical fixes. Every one is user-visible breakage today. None requires
restructuring. Land this phase before anything else — Phase 2 rebuilds on top of
a Reader that currently cannot navigate away from a search hit.

---

## F-01 — Find-in-book traps the reader on the hit page

**Proven.** A harness mirroring the exact wiring produced:

```
after search jump, page = 42
after clicking Next (expected 43), page = 42     <- snaps back
idle 2s: 3 resolutions | +2s at 4Hz (8 ticks): 7 more resolutions
```

**Cause — three defects compounding:**

1. `useReaderPageLifecycle.js:134` returns a fresh object literal every render,
   so `Reader.jsx:328-330`'s effect (deps `[search.result, lifecycle]`) re-fires
   on every render.
2. `useReaderSearch.result` is sticky — nothing calls `search.reset()` after the
   jump is consumed.
3. `run()` (`useReaderPageLifecycle.js:81-119`) has no "already on this page"
   guard, and `onContent` calls `setPageNumber(ctx.page)`.

Reader re-renders ~4 Hz from `transport.currentTime` during playback, so each
second fires ~4 full page resolutions (a `getPreparedPage` round trip or a PDF
text extraction).

**Tasks**

- [ ] Memoize the lifecycle return:
      `useMemo(() => ({ isLoading, browsePage, loadPage }), [isLoading, browsePage, loadPage])`.
- [ ] Add a no-op guard at the top of `run()`: if `kind === 'browse'` and the
      clamped target equals the currently-rendered page with content already
      resolved, return without bumping `requestIdRef`.
- [ ] In `Reader.jsx`, consume the search result exactly once — call
      `search.reset()` after `lifecycle.browsePage(search.result)`, or track the
      last-consumed result in a ref.
- [ ] Keep `searchStatus` ("Found … on page N") working after the reset — it
      currently reads `search.result`. Store the landed page separately.

**Acceptance**

- After a successful search, Next/Prev/page-jump navigate freely.
- With a search result set, N idle seconds produce **zero** additional
  `resolveContent` calls.
- The "Found … on page N" status still renders after the jump.

**Regression test** — `frontend/src/components/reader/Reader.test.jsx`: mount
with a stubbed finder returning page 42, submit a search, record the
`resolveContent` call count, advance timers 2s, assert the count is unchanged,
then navigate to 43 and assert the rendered page is 43.

---

## F-02 — Book-actions menu never closes on outside click

`LibraryView.jsx:29-38`. `onOutside` is bound to the menu root itself via
`onMouseDown`, then tests `!rootRef.current.contains(event.target)`. Events only
reach that handler from targets **inside** the root, so the condition is always
false and `close()` is unreachable.

**Tasks**

- [ ] Replace with a `document`-level `pointerdown` listener registered in a
      `useEffect` gated on `open`, removed on close and unmount.
- [ ] Keep the existing Escape handling and focus return to the trigger.

**Acceptance** — open the menu, click anywhere else on the page, menu closes.

**Regression test** — `LibraryView.test.jsx`: open the menu, fire `pointerdown`
on `document.body`, assert the menu unmounts.

---

## F-03 — CSP blocks the inline theme bootstrap

`backend/main.py:137-141` sets `default-src 'self'` with **no `script-src`** and
no nonce or hash (only `style-src` carries `unsafe-inline`).
`frontend/index.html:10-40` is an inline `<script>`. Inline scripts are blocked
under `self` — so the pre-paint theme bootstrap never runs in the packaged app.
Every launch paints the default paper/light palette, then `useTheme`'s effect
swaps it after React mounts. Dark-mode users see a white flash on every start.

Two prior audits called this CSP "correct" and "strict" (`REVIEW.md:122`)
without catching that it blocks the app's own bootstrap.

**Pick one** (prefer the first — it keeps CSP tight):

- [ ] **Externalise** the bootstrap to `frontend/public/theme-boot.js` and load
      it with `<script src="/theme-boot.js">`. Covered by `default-src 'self'`,
      no CSP change needed. Must stay render-blocking in `<head>`.
- [ ] Or compute the script's SHA-256 at build time and add
      `script-src 'self' 'sha256-…'`. Brittle — the hash must be regenerated
      whenever the script changes.

**Also fix (same file):** the bootstrap's
`getComputedStyle(document.documentElement).getPropertyValue('--bg')` runs
before the stylesheet `<link>` — Vite injects it *after* the inline script (see
`backend/static/index.html:44-45`) — so it always returns `''` and falls through
to the hardcoded `#0d0d17`. The comment claiming it "Pulls `--bg` from
tokens.css" was never true. Either read the value from the JS palette map
introduced in F-14, or delete the `theme-color` sync and the comment.

**Acceptance**

- No CSP violation in the console on a production build served by the backend.
- Launching in dark mode shows no light flash.
- `meta[name=theme-color]` matches the active palette's `--bg` at first paint.

---

## F-04 — Reader toolbar unreachable below ~1225px

`reader.css:4` — `.reader-toolbar-row { display: inline-flex }` with **no
`flex-wrap`**, ~20 children that cannot shrink (`white-space: nowrap`, search
input fixed `width: 200px`, sleep select `min-width: 7.6rem`), inside
`.pdf-viewer-container { overflow-x: clip }` (`reader.css:178` — `clip`, so it
cannot even be scrolled to).

Minimum content width ≈ 1225px. Below that, search / sleep / zoom / fit are
clipped and permanently unreachable.

**The fix is already written.** `reader.css:367-377` carries a comment
describing exactly this bug — *"the single-line toolbar cannot fit a phone
viewport, and nowrap spills its zoom/fit controls past the container's
overflow-x clip where they cannot be reached. Wrap into stacked rows instead."*
— applied to `.reader-navigation` and `.reader-nav-primary`, **both dead classes
from the deleted PdfViewer**. The live class is not in the rule.

**Tasks**

- [ ] Add `flex-wrap: wrap; row-gap: var(--space-1)` to `.reader-toolbar-row`
      unconditionally, not only at a breakpoint.
- [ ] Retarget the `reader.css:369-377` rule to `.reader-toolbar-row`, or delete
      it once the base rule wraps — but keep the comment, it explains *why*.
- [ ] Confirm `overflow-x: clip` on `.pdf-viewer-container` is moot once the
      toolbar wraps; if not, scope the clip to the page stage only.

Phase 2 (F-13) replaces this toolbar entirely. This is the stop-the-bleeding
fix; do it anyway so 2.8.1 ships without depending on Phase 2.

**Acceptance** — at 1280, 1024, 820, 768 and 390 px viewport widths, every
toolbar control is visible and clickable.

**Regression test** — assert `.reader-toolbar-row` declares `flex-wrap` in the
stylesheet contract test. A true layout assertion needs the Playwright harness
(see `VERIFY.md`).

---

## F-05 — Home/Library errors silently swallowed

`App.jsx:141,145` passes `onError={() => {}}` to `HomeView` and `LibraryView`.
Both route library-load **and** add-a-book failures there (`HomeView.jsx:40`,
`LibraryView.jsx:138`). Pick a corrupt PDF: the spinner stops, nothing happens,
no toast, no message.

`LibraryView` already holds a `toast` (line 120) and uses it for other actions —
this is an oversight, not a design choice.

**Tasks**

- [ ] Delete the `onError` prop from both call sites. Have each view raise its
      own failures through `useToast()` directly (Library already imports it;
      add it to Home).
- [ ] `useUserConfig.js:49-53` — a failed config GET does `setConfig({})`,
      indistinguishable from an empty config. Return a `loadError` alongside
      `config` and surface it in `SettingsView` via the existing
      `.status-banner.error`.

**Acceptance** — a failing `importPreparedBook` shows an error toast naming the
failure on both Home and Library; a failing config GET shows a banner in
Settings.

**Regression test** — mock `importPreparedBook` to reject; assert a toast with
the error message renders. One test per view.

---

## F-06 — Modal scrim inverts in dark mode

`controls.css:424` — `background: color-mix(in srgb, var(--ink) 45%, transparent)`.
`--ink` is near-black in light mode and near-**white** in dark mode. Measured:

| mode | bg luminance | scrim luminance | effect |
|---|---|---|---|
| light | 0.874 | 0.275 | darkens (correct) |
| dark | 0.004 | 0.165 | **brightens ~40x** |

Opening a dialog in dark mode washes the app in light grey.

**Tasks**

- [ ] Introduce a `--scrim` semantic token, defined per mode in `tokens.css`
      (light: `color-mix(in srgb, var(--ink) 45%, transparent)`; dark: a fixed
      dark value such as `color-mix(in srgb, var(--gray-950) 65%, transparent)`).
- [ ] Consume `var(--scrim)` in `.modal-overlay`. Grep for other `--ink`-based
      overlay backgrounds and convert them too.

**Acceptance** — in all five palettes × dark mode, opening a modal visibly
darkens the background.

**Regression test** — extend the `tokens.css` contract assertion in
`styles-parity.test.js` to require `--scrim` in both the light and dark block of
every palette.

---

## F-14 — All palette swatches render identically

`useTheme.js:31-43` — `readCssVarFor` appends a
`<div data-palette="blue" data-mode="dark">` and reads `--accent` from it. But
**all ten palette rules are `:root[data-palette=…]`-scoped**
(`tokens.css:22-303`). A `<div>` can never match `:root`, so `getComputedStyle`
returns the value inherited from `<html>` — the *currently active* accent.

The Settings palette picker (`SettingsView.jsx:97`) therefore shows ten
identical swatches and previews nothing. It also mutates the DOM and forces
synchronous layout **during render**, ten times, on every render — unsafe under
StrictMode and concurrent rendering.

**Tasks**

- [ ] Replace `readCssVarFor` / `getSwatchColor` with a static palette→accent map
      exported from `useTheme.js` (extend the existing `PALETTES` array with
      `light` and `dark` accent hexes).
- [ ] Delete the probe-div code path entirely. No DOM work during render.
- [ ] Add a test asserting the map covers every id in `PALETTES` × both modes,
      and that all ten values are distinct.

**Acceptance** — the five palettes show five visibly different swatch pairs; no
DOM mutation occurs during `SettingsView` render.

---

## F-15 — Settings view has no top-bar title

`App.jsx:19-25` — `VIEW_TITLES` has `home, library, reader, scan, studio`. No
`settings`. `contextTitle` (line 114) resolves to `''`, so
`<h2 className="topbar-title">` renders empty on the Settings screen, and the
Suspense fallback degrades to "Loading app…".

**Tasks**

- [ ] Add `settings: 'Settings'` to `VIEW_TITLES`.
- [ ] Add a test asserting every view the sidebar can navigate to (including
      `settings`) has a non-empty title, so the next added view cannot repeat
      this.

**Acceptance** — the top bar reads "Settings" on the Settings view.

---

## Exit gate

- [ ] All eight findings marked `verified` in `FINDINGS.md`.
- [ ] Eight regression tests added; each demonstrated failing before its fix.
- [ ] Full verification suite green (`VERIFY.md`).
- [ ] `backend/static` rebuilt and committed; `check_static_sync.py` passes.
