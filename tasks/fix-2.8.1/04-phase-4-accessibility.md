# Phase 4 — Accessibility

**Findings:** F-22 … F-31, F-42 · **Risk:** low · **Depends on:** Phase 2, Phase 3

The repo already ships an axe-core harness at `scripts/audit_a11y.py` that boots
the real frontend against a stub backend and scans five routes in light and dark
plus a keyboard traversal. **Run it first to get a baseline**, then work the list
below — several findings are things axe cannot detect (live-region timing,
tooltip-only explanations, reduced-motion behaviour) and several it will catch
that this review did not enumerate.

```bash
python scripts/audit_a11y.py --json tasks/fix-2.8.1/a11y-baseline.json
```

---

## F-22 — Light-mode contrast failures

Computed, not estimated:

| Usage | Ratio | AA (4.5) |
|---|---|---|
| `.engine-chip.is-ready` — `--success` on `--surface`, 12px | **4.08** | ✗ |
| `.status-banner.error` text on `--error-bg` | **4.27** | ✗ |
| `.status-banner.warning` text on `--warning-bg` | **3.99** | ✗ |
| `.btn.primary.danger` — `--accent-on` on `--live` | **4.30** | ✗ |
| `--ink-faint` on `--surface` (light / dark) | **3.25 / 3.35** | ✗ |
| `--ink-muted` on `--surface` (light / dark) | 5.42 / 5.99 | ✓ |
| `.transcript-word.current` | 6.03 | ✓ |

All dark-mode equivalents pass — the failures are light-mode only.

**Tasks**

- [ ] Darken the light-mode `--success`, `--error`, `--warning` and `--live`
      values until each pairing clears 4.5:1. They are used at 12–13px, so the
      large-text exemption does not apply.
- [ ] `--ink-faint` has exactly one text usage (`.studio-autosave`,
      `studio.css:218`); elsewhere it is decorative (the engine-chip dot). Either
      darken it or stop using it for text and rename it to signal
      "non-text only".
- [ ] `.transport-play.is-playing` (`--surface` on `--signal`) is 3.25 — fine for
      an icon-only control under 1.4.11's 3:1, but it is defined **twice with
      different `color` values**: `controls.css:545` and `reader.css:396-400`
      (reader wins). Collapse to one definition. `.transport-primary`,
      `.transport-secondary` and `.playback-transport` are likewise split across
      both files, and `.transport-secondary` appears twice within `reader.css`.
- [ ] Add a contrast assertion to the test suite so token edits cannot regress
      this — compute the ratio for the semantic pairs and fail below 4.5.

**Acceptance** — every foreground/background token pair used for text clears
4.5:1 in all five palettes × both modes, enforced by a test.

---

## F-23 — Two `banner` landmarks

`App.jsx:121` renders `<header className="main-header">` wrapping `TopBar`,
which itself renders `<header className="topbar">` (`TopBar.jsx:10`). Neither is
inside `main`/`article`/`section`, so **both map to `role="banner"`**. A page
should expose one.

- [ ] Make the inner element a `<div>`. Keep the outer `<header>`.

---

## F-24 — Heading order starts at `h2`

`.topbar-title` is an `<h2>`; `SettingsView` and `LibraryView` then render `<h1>`
inside `main`. The Reader has **no `h1` at all** (`reader-open-title` is an
`h2`). The first heading on every screen is an h2.

**Tasks**

- [ ] The top-bar title is a label, not a document heading — make it a `<div>`
      or `<span>` with the same class, or `aria-hidden` if the view's own `h1`
      already names the screen.
- [ ] Give the Reader an `h1` (the book title is the natural candidate — it also
      fixes the fact that the Reader never displays what you are reading).
- [ ] Add a test asserting each view renders exactly one `h1`.

---

## F-25 — Six-plus concurrent live regions in the Reader

`aria-live="polite"` on the page status **and** on the zoom percentage
(`Reader.jsx:577,672`), plus `role="status"` on search status, "Generating
narration…", `statusHint`, and library loading. Ctrl+wheel zoom fires an
announcement per tick.

**Tasks**

- [ ] Keep **one** polite live region for reader status; route page changes,
      search results and narration state through it.
- [ ] Remove `aria-live` from the zoom percentage entirely — the zoom buttons
      already have accessible names and the value is visible.
- [ ] Debounce or drop per-tick announcements.

---

## F-26 — Toast announcements are unreliable, and time out

`Toast.jsx:115-120` inserts a node that *already contains* its text and carries
`role="alert"`. Screen readers reliably announce mutations *within* an existing
live region; regions inserted with content are inconsistent (notably NVDA and
JAWS). `.toast-region` is persistent but is `role="region"`, not live.

**Tasks**

- [ ] Move the live semantics to the persistent container: `.toast-region` gets
      `aria-live="polite"`, plus a sibling `aria-live="assertive"` region for
      errors (`.toast-region-error` already has styling — this is what it was
      for). Individual toasts become plain nodes.
- [ ] 4s auto-dismiss with no pause-on-hover/focus violates WCAG 2.2.1. Pause the
      timer on hover and on focus-within; do not auto-dismiss errors at all.
- [ ] If the dismiss button is focused when a toast expires, focus drops to
      `<body>` — move it somewhere sensible.
- [ ] `useToast()` returns silent no-ops when the provider is missing
      (`Toast.jsx:146`). Add a `console.warn` in dev so a missing provider is
      not a silent swallow.
- [ ] Add `type="button"` to the dismiss button.

---

## F-27 — `role="menu"` without the keyboard pattern

`LibraryView.jsx:52` declares `role="menu"` / `role="menuitem"`, promising
arrow-key navigation, but focus never moves into the menu on open and only Tab
works.

- [ ] Implement the pattern: focus the first item on open, Up/Down to move,
      Home/End, Escape to close and return focus. Or drop the roles and let it be
      a plain popover of buttons.
- [ ] Whichever you choose, use the same contract for the Reader's "More"
      popover from F-13. One pattern, one implementation.

---

## F-28 — Disabled controls explain themselves only via `title`

`LibraryView.jsx:85-99` — "Prepare the book first" lives in a tooltip on a
**non-focusable** element. Keyboard and touch users can never read why the action
is unavailable.

- [ ] Move the reason into visible helper text in the menu, or keep the control
      enabled and explain on activation.

Same pattern in `TopBar.jsx:16` — `engineStatus.detail` is important diagnostic
information ("CUDA unavailable, falling back to CPU") reachable only by hovering
a chip. Surface it somewhere reachable.

---

## F-29 — Palette buttons have no accessible name but `title`

`SettingsView.jsx:84-101` — contents are an `aria-hidden` swatch plus an optional
check icon. `title` is the accessible-name fallback of last resort.

**Tasks**

- [ ] Add explicit `aria-label` (e.g. "Aurora Ink, dark").
- [ ] The set is single-choice modelled as 10 individually tabbable
      `aria-pressed` buttons. Convert to a `radiogroup` — one tab stop, arrow
      keys between options.
- [ ] `role="group" aria-label="Color palette"` also selects the mode; rename to
      match what it actually controls.

---

## F-30 — Reduced motion removes all loading feedback

`base.css:196-202` applies the blanket
`animation-duration: 0.01ms; animation-iteration-count: 1`. Consequences:

- `.spinner` freezes mid-rotation
- `.skeleton` shimmer stops
- `.loading-waveform` bars freeze at `scaleY(0.3)` — five 5px stubs
- `.loading-progress::after` freezes at `translateX(-100%)` — **completely
  invisible**

`controls.css:722-724` calls these the "contextual loading vocabulary" replacing
spinners. For reduced-motion users there is no indicator at all.

**Tasks**

- [ ] Add explicit `prefers-reduced-motion` fallbacks: `.loading-progress` → a
      static indeterminate stripe or a determinate bar; `.loading-waveform` →
      static full-height bars; `.spinner` → pair with visible text.
- [ ] Ensure every loading state has a text label, not only an animated glyph.
- [ ] Keep the blanket rule — it is the right default — but stop it from
      silently deleting information.

**Acceptance** — with reduced motion forced on, every loading state is still
perceivable.

---

## F-31 — Focus ring rewrites geometry; no forced-colors support

`base.css:88-93` sets `border-radius: var(--radius-sm)` on *every* focused
element. Import order saves most cases (component rules load later and win), but
any element without its own radius rule visibly changes shape on keyboard focus.

**Tasks**

- [ ] Remove `border-radius` from the `:focus-visible` rule. Style the outline,
      not the element. Modern browsers already follow the element's own radius.
- [ ] Add a `@media (forced-colors: active)` block. This is a Windows desktop
      app; High Contrast is a first-class mode. At minimum: keep focus outlines
      visible (`outline-color: Highlight`), do not rely on `background` alone to
      convey state, and check the `.is-active` / `.current` styles that use
      `--accent-soft` fills.

---

## F-42 — Navigation landmark and RTL safe-area

- [ ] `Sidebar.jsx:40-51` — the Settings button sits **outside**
      `<nav aria-label="Main">`. Move it inside, or wrap the footer in its own
      labelled nav.
- [ ] `shell.css:482` — the mobile sidebar's 3-value padding shorthand uses
      `env(safe-area-inset-left)` for **both** left and right. On a landscape
      notched phone the insets differ. Use logical properties or set each side.
- [ ] `base.css:66-70` redefines `--font-reading` for `[lang="ar"]` / `[dir="rtl"]`
      — good. Verify nothing else in the app assumes LTR (the toolbar's
      `margin-left: auto` patterns in particular).

---

## Exit gate

- [ ] `python scripts/audit_a11y.py` reports **zero** axe violations on all five
      routes in both modes, or every remaining violation is listed in
      `FINDINGS.md` with a written justification.
- [ ] Keyboard-only traversal of every route reaches every control and shows a
      visible focus indicator at each stop.
- [ ] Contrast test added and green.
- [ ] Manual screen-reader smoke on the toast system and the Reader status
      region (NVDA or Narrator — this is a Windows app).
- [ ] Reduced-motion pass: every loading state still perceivable.
- [ ] Full verification suite green; `backend/static` rebuilt and committed.
