# Findings index — 2026-09-20 deep review of v2.8.0 (`4524079`)

Stable IDs. Update **Status** as work lands: `open` → `in-progress` → `fixed` →
`verified`. A finding is `verified` only when a regression test that failed
before the fix now passes.

Severity: **S1** user-visible breakage · **S2** major gap/regression ·
**S3** polish, a11y, hygiene.

| ID | Sev | Finding | Primary location | Phase | Status |
|---|---|---|---|---|---|
| F-01 | S1 | Find-in-book traps the reader on the hit page; re-resolves content every render | `Reader.jsx:328-330`, `useReaderPageLifecycle.js:134` | 1 | verified |
| F-02 | S1 | Book-actions menu never closes on outside click | `LibraryView.jsx:29-38` | 1 | verified |
| F-03 | S1 | CSP blocks the inline theme bootstrap → flash of wrong theme | `main.py:137-141`, `index.html:10-40` | 1 | verified |
| F-04 | S1 | Reader toolbar unreachable below ~1225px; existing fix targets deleted classes | `reader.css:4,178,367-377` | 1 | verified |
| F-05 | S1 | Home/Library errors silently swallowed by `onError={() => {}}` | `App.jsx:141,145` | 1 | verified |
| F-06 | S1 | Modal scrim inverts (brightens) in dark mode | `controls.css:424` | 1 | verified |
| F-07 | S2 | Reader lost scrubber, time, rate, transcript, bookmark jump, voice/language | `Reader.jsx`, `PlaybackControls.jsx` | 2 | verified |
| F-08 | S2 | `useWordHighlight`/`pdfHighlight`/`wordPronunciation` fully orphaned | `hooks/useWordHighlight.js` | 2 | deferred (partial) |
| F-09 | S2 | `lifecycle.isLoading` never consumed; false empty state on every page turn | `Reader.jsx`, `TextStage.jsx:11-13` | 2 | verified |
| F-10 | S2 | Mobile transport padding applied to the wrong component | `reader.css:186-189,1189` | 3 | verified |
| F-11 | S2 | 89 of 421 CSS classes orphaned; parity test guards only one direction | `styles/*.css`, `styles-parity.test.js` | 6 | verified |
| F-12 | S2 | Text books render as one `<p>` — all paragraph structure lost | `TextStage.jsx:22` | 2 | verified |
| F-13 | S2 | Reader toolbar is a flat undifferentiated row of ~20 controls | `Reader.jsx:570-720` | 2 | verified |
| F-14 | S2 | All palette swatches render identically; DOM mutation during render | `useTheme.js:31-46`, `SettingsView.jsx:97` | 1 | verified |
| F-15 | S2 | Settings view has no top-bar title | `App.jsx:19-25` | 1 | verified |
| F-16 | S2 | Four different touch-target sizes (44/36/32/28); `.compact` alias missed | `controls.css:122,150,673`, `studio.css:643` | 3 | verified |
| F-17 | S2 | `Button` `size` prop inert — size classes live in `base.css`, overridden by `controls.css` | `base.css:184,190` | 3 | verified |
| F-18 | S3 | `backdrop-filter` where nothing passes behind; double blur on modals | `shell.css:27,44`, `controls.css:425,444` | 3 | verified |
| F-19 | S2 | `100vh` on a phone-targeted app | `shell.css:5,20` | 3 | verified |
| F-20 | S2 | Toast region collides with the mobile bottom nav | `shell.css:762-773` | 3 | verified |
| F-21 | S3 | Library visually flat; no covers; `.prepared-book-row` lacks `cursor: pointer`; row markup duplicated and drifted | `reader.css:1146`, `Reader.jsx:549-562` | 3 | verified |
| F-22 | S2 | Light-mode contrast failures (5 token pairs below AA) | `tokens.css`, `shell.css`, `controls.css` | 4 | verified |
| F-23 | S2 | Two `banner` landmarks (nested `<header>`) | `App.jsx:121`, `TopBar.jsx:10` | 4 | verified |
| F-24 | S3 | Heading order starts at `h2`; Reader has no `h1` | `TopBar.jsx:11`, `Reader.jsx:527` | 4 | verified |
| F-25 | S3 | Six-plus concurrent live regions in the Reader | `Reader.jsx:577,672` | 4 | verified |
| F-26 | S2 | Toast live regions inserted with content — unreliable announcement; 4s auto-dismiss, no pause | `Toast.jsx:115-120,146` | 4 | verified |
| F-27 | S3 | `role="menu"` without the keyboard pattern | `LibraryView.jsx:52` | 4 | verified |
| F-28 | S3 | Disabled controls explain themselves only via `title` | `LibraryView.jsx:85-99` | 4 | verified |
| F-29 | S3 | Palette buttons have no accessible name but `title`; should be a radiogroup | `SettingsView.jsx:84-101` | 4 | verified |
| F-30 | S2 | Reduced motion removes all loading feedback | `base.css:196-202`, `controls.css:722-780` | 4 | verified |
| F-31 | S3 | `:focus-visible` rewrites element `border-radius`; no `forced-colors` support | `base.css:88-93` | 4 | verified |
| F-32 | S3 | Refs written during render | `Reader.jsx:229,237,412`, `Modal.jsx:70` | 5 | verified |
| F-33 | S2 | `useUserConfig` per-instance with no shared invalidation; null-config crash path | `useUserConfig.js`, `LibraryView.jsx:123` | 5 | verified |
| F-34 | S2 | False data-loss warning after a successful scan save | `App.jsx`, `BookSession.jsx:169-185` | 5 | verified |
| F-35 | S2 | Theme: no follow-system, no `matchMedia` listener, no palette validation | `useTheme.js`, `index.html` | 5 | verified |
| F-36 | S3 | Progress visibility flush documented but not implemented | `Reader.jsx:305-306` | 5 | verified |
| F-37 | S3 | Vestigial `userTouched*` refs; five stale comments referencing deleted code | `Reader.jsx:94-95` and others | 6 | verified |
| F-38 | S3 | "Try again" on PDF error retries nothing; double error reporting | `Reader.jsx:735-745` | 2 | verified |
| F-39 | S3 | Silent deep-link miss; `openBook` never persists the view | `Reader.jsx:398`, `App.jsx:96-108` | 5 | verified |
| F-40 | S3 | View transition: hardcoded 200ms timer; title/content disagree during it | `App.jsx:57-71,114` | 5 | verified |
| F-41 | S3 | Inconsistent loading treatment Home vs Library; CLS; triple "Loading settings…" | `HomeView.jsx:126`, `SettingsView.jsx` | 3 | verified |
| F-42 | S3 | Settings button outside `<nav>`; sidebar RTL-unsafe safe-area padding | `Sidebar.jsx:40-51`, `shell.css:482` | 4 | verified |
| F-43 | S3 | Backend uses `print()` not `logging`; CWD-relative `STATIC_DIR`; seed at import time | `backend/main.py:34-37,166` | 6 | partial (logging = own PR) |
| F-44 | S3 | Misc: undebounced PDF resize re-render, hardcoded scrubber offset, no-op 480px rule, missing `type="button"` | various | 6 | verified |

## Deferred / explicitly out of scope

- Book cover thumbnails (F-21 second half) — a feature, not a fix. Track separately.
- Backend `logging` migration (F-43) — touches ~50 call sites; land as its own PR.
- Content-addressed book ids: re-importing an edited file orphans progress.
  Behaviour is intentional; documented here so it is not "fixed" by accident.
- F-45 (new, 2026-09-20, found during Phase 4 gating): **RESOLVED during Phase 6 — see
  LOG "F-45 resolution".** Originally: `python -m pytest tests -q` failed 11 backend
  tests (test_tts_lifecycle ×10, test_voice_conversion ×1) in full-suite order only,
  reproducible even in clean worktrees at the pre-remediation baseline `4524079`.
  Bisect root cause: `tests/test_pronunciation_cache_privacy.py` deleted
  `services.tts_service.*` from `sys.modules` in `setUp` and never restored the
  originals — every later test file ran against duplicate module instances. The
  "missing local model weights" errors were a symptom of the duplicated state, not a
  machine defect. Fixed in the test (snapshot + in-place reordering reloads); the full
  suite is now 478 passed / 0 failed, and the print()→logging migration for F-43 no
  longer has an environment blocker.
