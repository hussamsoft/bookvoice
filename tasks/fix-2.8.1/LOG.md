# Phase log

Append one entry per finding. Newest last.

Format:

```
## F-nn — <short title>            [phase N] <date>
Test:      <test file :: test name>
Failed as: <the failure output before the fix>
Changed:   <files touched, one line each>
Gate:      pytest OK / lint OK / vitest OK / build OK / static-sync OK
Notes:     <deferrals, surprises, decisions>
```

---

_(no entries yet)_

## F-01 — Find-in-book traps the reader on the hit page            [phase 1] 2026-09-20
Test:      frontend/src/components/reader/Reader.test.jsx :: "does not trap navigation on the search hit and does not re-resolve idle"
Failed as: after search jump to page 7, clicking "Next page" left the reader stuck on "Server page 7 text" — findByText(/Server page 8 text/) timed out (waitFor timeout in query-helpers).
Changed:   (pending fix)
Gate:      (pending)
Notes:     in progress

## F-02 — Book-actions menu never closes on outside click       [phase 1] 2026-09-20
Test:      frontend/src/components/shell/LibraryView.test.jsx :: "closes the book-actions menu on an outside click"
Failed as: fireEvent.mouseDown(document.body) on the open menu — waitFor query for `screen.queryByRole('menu', { name: 'Book actions' })` timed out, menu stayed in the DOM.
Changed:   frontend/src/components/shell/LibraryView.jsx (root onMouseDown → document-level mousedown effect)
Gate:      (pending)
Notes:     n/a

## F-03 — CSP blocks the inline theme bootstrap                [phase 1] 2026-09-20
Test:      tests/test_theme_bootstrap_externalized.py :: ThemeBootstrapExternalizedTests
Failed as: test_index_html_has_no_inline_script_block / test_index_html_loads_theme_boot_as_external_script / test_theme_boot_file_exists_and_is_minimal — inline <script> in index.html lacks `src=`, no `theme-boot.js` reference, and `frontend/public/theme-boot.js` does not exist.
Changed:   frontend/index.html (inline script → <script src="/theme-boot.js">); new frontend/public/theme-boot.js (externalised bootstrap, removed bogus getComputedStyle('--bg') read — that always returned '' pre-link).
Gate:      (pending; the 4th test (static-bundle parity) skips until rebuild)
Notes:     `meta[name=theme-color]` is left hard-coded — the bogus read was always '' pre-link so removing it only stops pretending. A later phase can wire theme-color from the JS palette map (F-14 territory).

## F-04 — Reader toolbar unreachable below ~1225px           [phase 1] 2026-09-20
Test:      frontend/src/styles/reader-toolbar.test.js :: "reader toolbar layout (F-04)"
Failed as: (after the first attempt with overly-broad selectors — retargeted) — first version flagged `.reader-navigation` references; current version asserts `.reader-toolbar-row` declares `flex-wrap: wrap` and a @media block mentions the live selector.
Changed:   frontend/src/styles/reader.css (added `flex-wrap: wrap; row-gap: var(--space-1);` to base rule; retargeted the 720px @media block to `.reader-toolbar-row`)
Gate:      (pending)
Notes:     scrim removed in base rule keeps room for future tightening; the @media block is left as a no-op safety net.

## F-05 — Home/Library errors silently swallowed              [phase 1] 2026-09-20
Test:      HomeView.test.jsx :: "surfaces an import failure as a toast, not a silent swallow"; LibraryView.test.jsx :: "surfaces an add-book failure as a toast"
Failed as: original catch in HomeView/LibraryView called `onError?.(err)` only; the App shell passed `onError={() => {}}` so the user saw nothing.
Changed:   HomeView.jsx (useToast + toast.error in catch), LibraryView.jsx (same), App.jsx (drop the `onError={() => {}}` props)
Gate:      (pending)
Notes:     n/a

## F-06 — Modal scrim inverts in dark mode                     [phase 1] 2026-09-20
Test:      frontend/src/styles/scrim.test.js :: "modal scrim token (F-06)"
Failed as: --scrim token not declared in tokens.css; .modal-overlay used `color-mix(... var(--ink) 45% ...)` which inverts in dark.
Changed:   tokens.css (added `--scrim: color-mix(in srgb, var(--gray-950) 65%, transparent)` in shared block), controls.css (.modal-overlay uses var(--scrim))
Gate:      (pending)
Notes:     n/a

## F-14 — All palette swatches render identically             [phase 1] 2026-09-20
Test:      frontend/src/hooks/useTheme.test.js :: "palette swatches (F-14)"
Failed as: original `readCssVarFor` appended a probe div and called getComputedStyle — :root-scoped rules never matched so all swatches resolved to the active accent; the spy on body.appendChild caught this and failed.
Changed:   useTheme.js (static PALETTES map with light/dark accents; `getSwatchColor` reads from it; removed `readCssVarFor` and probe-div code path)
Gate:      (pending)
Notes:     n/a

## F-15 — Settings view has no top-bar title                  [phase 1] 2026-09-20
Test:      App.test.jsx :: "shows the Settings top-bar title and exposes a Settings nav button"
Failed as: topBarTitle.textContent was ''; Suspense fallback degraded to "Loading app…".
Changed:   App.jsx (added settings: 'Settings' to VIEW_TITLES)
Gate:      (pending)
Notes:     n/a
