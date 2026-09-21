# Phase 5 — State, theme, and architecture

**Findings:** F-32 … F-36, F-39, F-40 · **Risk:** medium · **Depends on:** Phase 1

Correctness bugs in state ownership and lifecycle. Lower user-visibility than
Phase 1 but each is a real defect, and several are the kind that produce
"impossible" bug reports later.

---

## F-32 — Refs written during render

`Reader.jsx:229` `narrationRef.current = narration`, `:237`
`sleepRef.current = sleep`, `:412` `openLibraryBookRef.current = openLibraryBook`,
and `Modal.jsx:70` `onCloseRef.current = onClose`.

Writing to a ref during the render phase is a documented React anti-pattern —
unsafe under concurrent rendering and StrictMode double-invocation. These work
today by luck of the current scheduler.

**Tasks**

- [ ] Move each assignment into a `useEffect` (the pattern already used
      correctly in `useReaderPageLifecycle.js:64-67`).
- [ ] Where a ref exists purely to break a declaration cycle
      (`narrationRef` bridging `onContent` → narration), consider restructuring
      so the cycle does not exist — but a `useEffect` assignment is an acceptable
      minimal fix.
- [ ] Verify with `<StrictMode>` on (it already is, `main.jsx:25`) that no
      double-invocation artefacts appear.

**Acceptance** — no ref mutation in a render body across `frontend/src`.

---

## F-33 — `useUserConfig` is a per-instance cache with a null-crash path

Each caller holds its own `config` state. A save in `SettingsView` does not
invalidate any other mounted consumer — change the default voice in Settings and
a concurrently-mounted view keeps the stale value. Views mostly unmount on
navigation (`App.jsx` renders only `displayView`), which hides it, but it is
latent.

Worse: `LibraryView.jsx:123` does `config.voice_id` where `config` starts as
`null`. Clicking "Prepare whole book" before the GET settles throws
`TypeError: Cannot read properties of null`. `SettingsView` guards with
`config ? … : …`; this call site does not.

`useUserConfig.js:18-19`'s comment ("a second mount after the first resolves gets
`null` and skips loading") contradicts the `??=` on line 37, which starts a fresh
request.

**Tasks**

- [ ] Fix the crash first: `config?.voice_id ?? null` in `LibraryView.jsx:123-124`,
      and disable book actions until config has loaded.
- [ ] Lift config into a single provider (a small context around the app, beside
      `ToastProvider`) so there is one copy and one invalidation path. The hook's
      public shape can stay identical.
- [ ] Delete or correct the stale comment at lines 16-19.
- [ ] Add the `loadError` surfacing from Phase 1 F-05 if not already done.

**Acceptance** — one config instance app-wide; a save in Settings is visible
everywhere immediately; no crash when acting before config resolves.

**Regression test** — render `LibraryView` with config unresolved, invoke the
prepare action, assert no throw.

---

## F-34 — False data-loss warning after a successful scan save

`App.jsx` sets `scanDirty` via `onDirty`, cleared **only** in
`confirmPendingView`. `BookSession.handleSaveToLibrary` (`:169-185`) succeeds
without any `onClean` callback. Save your scan, then click a sidebar item →
*"Pages captured in this session are not saved yet."*

**Tasks**

- [ ] Add an `onSaved` / `onClean` prop to `BookSession`, called after a
      successful `importPreparedBook`, wired to `setScanDirty(false)` in `App`.
- [ ] While here: `openBook` (`App.jsx:96-108`) bypasses the dirty guard
      entirely. Decide whether that is intended (it is, for the post-save path)
      and comment it, or route it through the same check.

**Acceptance** — save a scan session to Library, navigate away via the sidebar,
no confirmation dialog.

**Regression test** — `BookSession.test.jsx`: successful save calls `onSaved`.

---

## F-35 — Theme has no follow-system, no live updates, no validation

`useTheme.js` captures `prefers-color-scheme` once at mount, then **persists it
on the first effect run** — permanently destroying the "follow system" state.
There is no `matchMedia` change listener, so OS theme switches never propagate.

Neither `useTheme` nor the bootstrap validates the stored palette against
`PALETTES`: a stale or hand-edited value yields `data-palette="…"` matching no
rule, silently falling back to paper/light while `data-mode` still says dark.
The bootstrap also carries three legacy key fallbacks for mode but only two for
palette.

**Tasks**

- [ ] Add `'system'` as a third mode value and make it the default. Only write
      an explicit `light`/`dark` to storage when the user chooses one.
- [ ] Subscribe to `matchMedia('(prefers-color-scheme: dark)')` change while in
      `system` mode.
- [ ] Validate on read: if the stored palette is not in `PALETTES` or the mode is
      not one of the known values, fall back to the default and rewrite storage.
      Apply the same validation in the bootstrap script (F-03 makes it a real
      file, which makes sharing the validation easy).
- [ ] Add a "System" option to the Settings appearance picker (it becomes a
      natural third column beside light/dark).
- [ ] Reconcile the legacy-key fallback lists between `useTheme.js:51-59` and the
      bootstrap.

**Acceptance** — a fresh install follows the OS theme and keeps following it
across OS changes until the user picks explicitly; a corrupt stored palette
self-heals.

---

## F-36 — Progress visibility flush documented but not implemented

`Reader.jsx:305-306` — *"Flush the pending progress save when the tab is hidden
or the reader unmounts, mirroring useReaderProgress's visibility flush."* Only
unmount is handled; there is no `visibilitychange` listener. Closing the tab
mid-read loses up to 3s of reading position.

- [ ] Add the `visibilitychange` listener the comment describes, or correct the
      comment. Prefer adding it — `useReaderProgress` already has the pattern to
      copy.

---

## F-39 — Silent deep-link miss; reader view not persisted

- `Reader.jsx:398` — if the `?book=` id is not in the library the effect returns
  with no feedback. A user double-clicking a `.bookvoice` file sees an empty
  reader and no explanation.
- `App.jsx:96-108` — `openBook` calls `setViewState('reader')` but never
  `setAppView('reader')`, unlike `navigate`. After opening a book and relaunching,
  the app restores the *previous* view.

**Tasks**

- [ ] Toast on deep-link miss, naming the id or file.
- [ ] Decide whether the reader should be a restorable view. If yes, call
      `setAppView('reader')` in `openBook`. If no, comment why.

---

## F-40 — View transition timing

`App.jsx:57-71` — a hardcoded 200ms JS timer paired to a CSS duration. Under
reduced motion the CSS is correctly disabled (`shell.css:885-888` keeps opacity
1) but the 200ms dead wait remains. `contextTitle` (line 114) reads `view` while
the stage renders `displayView`, so the title and content disagree for those
200ms.

**Tasks**

- [ ] Drive the swap from `transitionend` on `.mode-stage`, or read the duration
      from the token rather than duplicating `200` in JS.
- [ ] Skip the delay entirely when `prefers-reduced-motion: reduce` matches.
- [ ] Derive `contextTitle` from `displayView` so title and content agree.

**Acceptance** — reduced-motion users get an instant view swap; the title never
describes a screen that is not showing.

---

## Exit gate

- [ ] F-32 … F-36, F-39, F-40 marked `verified` in `FINDINGS.md`.
- [ ] Regression tests for F-33 (null config) and F-34 (dirty flag) at minimum.
- [ ] Manual: toggle the OS theme with the app open in `system` mode and watch it
      follow.
- [ ] Manual: corrupt `localStorage['bookvoice.palette']` to a junk value, reload,
      confirm it self-heals instead of rendering a mismatched theme.
- [ ] Full verification suite green; `backend/static` rebuilt and committed.
