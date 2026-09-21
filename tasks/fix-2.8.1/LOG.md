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

## F-07 — PlaybackControls wiring in Reader             [phase 2] 2026-09-20
Test:      Reader.test.jsx :: "exposes a working scrubber that agrees with the clock (F-07)"
Failed as: no `Narration position` labelled scrubber existed in the toolbar; Reader had inline play/stop/skip/mute but no time/scrubber/rate.
Changed:   Reader.jsx (mounts <PlaybackControls> with transport, onToggle, onStop, onSeek, duration=scrubberDuration, sleepRef, pageLabel, generating); removed duplicate inline transport controls.
Gate:      lint OK / vitest OK / build OK / static-sync OK
Notes:     scrubber-duration test seeds audio.duration=12 via Object.defineProperty and asserts both scrubber.max=12 and clock reads "0:00 / 0:12", proving they draw from the same source.

## F-13 — Group toolbar into nav + transport + More     [phase 2] 2026-09-20
Test:      Reader.test.jsx :: "groups the toolbar into navigation + transport + a more popover (F-13)"
Failed as: toolbar was a flat row of ~20 controls; no "More options" button existed.
Changed:   Reader.jsx (toolbar now: bookmark-icon / page-status / prev / next / page-jump / More-options trigger); <PlaybackControls> renders below; More-options popover groups zoom, mute, fit, search, and bookmark jumps. Bookmark button is now a fixed-width icon-only toggle (.reader-bookmark-toggle) so toggling doesn't shift neighbours.
Gate:      see F-07
Notes:     removed role="menu" from the popover (it isn't an ARIA menu pattern); a real menu pattern belongs to Phase 4 (F-27).

## F-38 — Relabel Try again -> Dismiss; drop redundant toast [phase 2] 2026-09-20
Test:      Reader.test.jsx :: "PDF error button is labelled Dismiss..."
Failed as: button labelled "Try again"; handleDocumentError also toast.error'd.
Changed:   Reader.jsx (.reader-pdf-error button now "Dismiss"; handleDocumentError no longer toasts).
Gate:      see F-07
Notes:     static contract test (file-source assertion) because jsdom cannot deterministically drive react-pdf onLoadError.

## F-08 — DEFERRED (partial)                            [phase 2] 2026-09-20
Decision:  Wire (per user prompt) — but partial. TextStage now wraps each word in a <span> and applies `.is-current-word` when `currentWord` matches; this is the downstream contract `useWordHighlight` will drive. Full hook integration in Reader was attempted but reverted: the hook's `requestAnimationFrame` loop interacts badly with `narrateTextStream`'s pending-Promise harness in tests, causing 11 unrelated Reader tests to time out. Defer the full hook wiring until word timings are reliably surfaced end-to-end.
Test:      TextStage.test.jsx :: "marks the current narration word with the highlight class (F-08)" (passing); useWordHighlight-adoption.test.js documents the deferral.
Changed:   TextStage.jsx (split paragraphs into word spans, currentWord prop); Reader.jsx (passes currentWord={null} — full integration deferred).
Gate:      see F-07
Notes:     The audit finding is partially addressed: the rendering contract is in place and verifiable, the hook is still orphaned. A follow-up issue should land the RAF integration with deterministic timings.

## F-10 — Mobile transport padding on wrong component   [phase 3] 2026-09-20
Test:      styles/transport-clearance.test.js (failed: .book-session absent from the ≤720px padding block; --transport-height still present)
Changed:   reader.css (media rule now covers .pdf-viewer-container AND .book-session), tokens.css (deleted dead --transport-height)

## F-16 — Touch-target size reconciliation              [phase 3] 2026-09-20
Test:      styles/touch-targets.test.js + components/PlaybackControls-compact.test.js (failed: no range/checkbox in coarse block; 720px override used --control-h-md; 'compact' in parity allowlist)
Changed:   PlaybackControls.jsx (.compact → .btn-compact; dropped inert wrapper class), controls.css (coarse block covers range+checkbox; ≤720px compact override raised to 44px), studio.css (documented 32px transcript-chip exception), styles-parity.test.js (allowlist entry removed)

## F-17 — Button size prop inert                        [phase 3] 2026-09-20
Test:      styles/button-sizes.test.js (failed: bare .btn-sm/.btn-lg only in base.css)
Changed:   base.css (removed bare rules), controls.css (.btn.btn-sm/.btn.btn-lg compounds with min-height; coarse block includes .btn.btn-sm)

## F-18 — backdrop-filter with nothing behind           [phase 3] 2026-09-20
Test:      styles/blur-and-toast.test.js (failed: blur on .main-header/.sidebar/.modal-panel)
Changed:   shell.css (dropped blur on .main-header/.sidebar), controls.css (dropped blur on .modal-panel; overlay keeps it)

## F-19 — 100vh on a phone app                          [phase 3] 2026-09-20
Test:      styles/viewport-height.test.js (failed: no dvh)
Changed:   shell.css (.app-shell/.app-column use 100dvh with 100vh fallback)

## F-20 — Toast collides with mobile bottom nav         [phase 3] 2026-09-20
Test:      styles/blur-and-toast.test.js (failed: no ≤720px offset; .toast-region-error present)
Changed:   tokens.css (new --bottom-nav-h token), shell.css (toast offset at ≤720px; deleted orphan .toast-region-error)

## F-21 — Library row cursor + drifted duplicate markup [phase 3] 2026-09-20
Test:      styles/prepared-book-row.test.js (failed: no cursor:pointer)
Changed:   reader.css (cursor:pointer, text-align:left, .prepared-book-row-title ellipsis), PreparedBookRow.jsx (title span), Reader.jsx (hand-rolled open-a-book rows replaced with <PreparedBookRow>)
Notes:     cover thumbnails remain deferred per FINDINGS.md

## F-41 — Inconsistent loading treatment                [phase 3] 2026-09-20
Test:      HomeView.test.jsx (skeleton slot; Adding… button), LibraryView.test.jsx (Adding… button), SettingsView.test.jsx (single loading status) — all failed first
Changed:   HomeView.jsx (skeletons reserve continue slot; bottom hint removed; unified add button), LibraryView.jsx (icon swapped for spinner + Adding… label), SettingsView.jsx (one page-level role=status; per-section duplicates removed)

---

Phase 4 (accessibility) — resumed 2026-09-20 on a dirty tree that already
carried uncommitted F-22..F-26 sources + tests + a static rebuild. Pre-fix
evidence for those five was produced retroactively: the five source files
were stashed (tests kept), the working-tree tests were run against HEAD, and
each failed as below; the stash was then restored. Findings F-27..F-31 and
F-42 were written failing-first in the normal order.

## F-22 — Light-mode contrast failures                   [phase 4] 2026-09-20
Test:      frontend/src/styles/contrast.test.js :: "WCAG AA contrast for semantic text pairs (F-22)"
Failed as: against HEAD tokens.css — paper/light: success 4.0847, error/error-bg 4.2680, warning/warning-bg 3.9927, accent-on/live 4.3038 — exactly the ratios in the finding table; blue/sage/plum/sand light error+warning pairs also below 4.5; all dark-mode pairs passed.
Changed:   tokens.css (darkened light --success/--error/--warning/--live per palette), studio.css (.studio-autosave --ink-faint → --ink-muted; --ink-faint is now decorative-only: the engine-chip dot), controls.css + reader.css (collapsed the duplicated .transport-play.is-playing / .transport-primary / .transport-secondary into single definitions in reader.css, absorbing controls.css's font-size/color — PlaybackControls' Studio usage is unaffected because main.jsx loads reader.css app-wide).
Gate:      lint OK / vitest OK / build OK / static-sync OK
Notes:     .transport-secondary previously carried `font-size: var(--text-xs)` from controls.css and color from both files; the merged reader.css rule keeps the computed union.

## F-23 — Two banner landmarks                           [phase 4] 2026-09-20
Test:      TopBar.test.jsx :: "renders no header element (App supplies the single banner) (F-23)"; App.test.jsx :: "exposes exactly one banner landmark in every view (F-23)"
Failed as: against HEAD TopBar.jsx — `expect(container.querySelector('header')).toBeNull()` found `<header class="topbar">`; queryByRole('banner') resolved it.
Changed:   TopBar.jsx (`<header className="topbar">` → `<div>`); BookSession.jsx, SettingsView.jsx (nested view `<header>`s → `<div>` — inside `<main>` they were not banners per spec, but the "make the inner element a div" rule is applied consistently; App.test guard documents it).
Gate:      see F-22
Notes:     App's outer `<header className="main-header">` remains the one banner.

## F-24 — Heading order; Reader had no h1                [phase 4] 2026-09-20
Test:      Reader.test.jsx :: "renders exactly one h1 in both the empty and open states (F-24)"; BookSession.test.jsx :: "names the scan view with exactly one h1 (F-24)"; App.test.jsx :: "each real view renders exactly one h1 (F-24)"
Failed as: against HEAD Reader.jsx — getByRole('heading', {level:1, name:/Open a book/}) found nothing (it was an h2); BookSession guard would fail on HEAD too (Scan had only h2/h3 — no h1 anywhere).
Changed:   Reader.jsx (empty-state h2→h1; toolbar h1 with the book title — the Reader now names what you are reading), TopBar.jsx (.topbar-title h2→div — a label, not a heading), BookSession.jsx (<h2>Scan pages</h2>→h1), VoiceStudio.jsx (fatal-error-state h2→h1), reader.css (.reader-book-title).
Gate:      see F-22
Notes:     DEFERRAL: the Voice Studio WORKBENCH (post-project-open) still has no h1 — its project header is a name-input row and re-heading it risks the 19 VoiceStudio tests; logged for a Phase 5-adjacent follow-up rather than widened here. The per-view exactly-one-h1 guard covers Home/Library/Settings/Reader/Scan; Studio landing has one (F-41-era workbench gap documented, not papered over).

## F-25 — Six-plus concurrent live regions in the Reader [phase 4] 2026-09-20
Test:      Reader.test.jsx :: "routes all reader status through a single polite live region (F-25)"
Failed as: against HEAD Reader.jsx — `container.querySelectorAll('[role="status"], [aria-live="polite"]')` counted 5+ (page-status span aria-live, statusHint role=status, search role=status, generating role=status, zoom-pct aria-live); the guard asserts exactly 1.
Changed:   Reader.jsx — ONE `<p className="sr-only" role="status">` that routes search status / generating / hint / page label through a single derived string; visible page-status, zoom %, search-status, generating lines are plain text now (no aria-live on zoom → no per-tick announcements).
Gate:      see F-22
Notes:     Ctrl+wheel zoom now announces nothing (buttons have names, value is visible) — matches the finding's intent.

## F-26 — Toast live regions + WCAG 2.2.1 timing         [phase 4] 2026-09-20
Test:      Toast.test.jsx :: "puts live semantics on the persistent regions, not the toast nodes (F-26)", "never auto-dismisses error toasts (F-26)", "pauses auto-dismiss while the region is hovered (F-26)", "the dismiss control is a real button (F-26)"; blur-and-toast.test.js :: "both live regions are styled and share the stack (F-26)"
Failed as: against HEAD Toast.jsx — `.toast-region` lacked aria-live="polite" (it was role="region" only; each toast node carried role=alert/status with its content pre-inserted); error toasts auto-dismissed at 4 s; hover did not pause; dismiss button had no type="button".
Changed:   Toast.jsx (persistent polite + assertive sibling regions, toasts become plain nodes, expiresAt bookkeeping with pause on hover/focus, errors never auto-dismiss, focus parked on the region when a focused toast expires, console.warn in DEV when the provider is missing, type="button"); shell.css (.toast-stack wrapper owns the fixed positioning + F-20 mobile clearance; regions styled; :empty regions suppressed); Toast.test's older role-based queries retargeted to `.toast` (the toast nodes genuinely no longer have status/alert roles — premise superseded, assertion strength preserved).
Gate:      see F-22
Notes:     SUPERSEDED PREMISE: blur-and-toast.test.js's "the orphaned .toast-region-error selector is gone" (F-20) is replaced by the F-26 contract that re-renders `.toast-region-error` deliberately — the fixed-position/overlap-safe stack + calc/--bottom-nav-h clearance assertions are carried over unchanged onto `.toast-stack`, so F-20's actual guarantee (toasts never cover the nav) still has a test.
Notes:     Screen-reader smoke (NVDA) remains a manual exit-gate item — not runnable here; the DOM contract the SR depends on is test-covered.

## F-27 — Popovers: one pattern, one implementation      [phase 4] 2026-09-20
Test:      LibraryView.test.jsx :: "book-actions popover follows the shared keyboard pattern (F-27)"; Reader.test.jsx :: "More options popover follows the shared keyboard pattern (F-27)"
Failed as: open menu → getByRole('group', {name:'Book actions'}) absent (it was role="menu"); focus stayed on the trigger; ArrowDown/Home/End cycled nothing; Escape left focus wherever it was.
Changed:   NEW frontend/src/hooks/usePopoverMenu.js — disclosure contract shared by both popovers: focus first enabled control on open, Down/Up wrap between enabled controls, Home/End, Escape closes and restores focus to the trigger. LibraryView.jsx (dropped role="menu"/"menuitem", role="group" + refs + hook), Reader.jsx (same hook on the More popover, role="group"). The ARIA-menu alternative was rejected because the Reader popover holds a search field and zoom buttons, which are not menuitems — the finding offers "or drop the roles"; this lands the drop-the-roles option with the promised keyboard behaviour.
Gate:      lint OK / vitest OK / build OK / static-sync OK
Notes:     Existing LibraryView tests that queried by role=menuitem were retargeted to buttons — same interactions asserted, corrected roles (superseded premise, not weakened).

## F-28 — Disabled controls / engine chip explain via tooltip only [phase 4] 2026-09-20
Test:      LibraryView.test.jsx :: "shows the disabled-action reason as visible text, not only a tooltip (F-28)"; TopBar.test.jsx :: "surfaces the engine detail as reachable text, not only a tooltip (F-28)" + "renders no detail element when there is nothing to explain"
Failed as: with a profile-less book, no text "Prepare the book first" existed in the popover (title attribute only); TopBar detail rendered only as title={...} — getByRole('status') had no textContent.
Changed:   LibraryView.jsx (.book-actions-menu-hint paragraph when !hasProfile; disabled buttons keep tooltips only when ENABLED), TopBar.jsx (.engine-chip-detail span when detail non-empty), reader.css + shell.css (hint + chip-detail styling, ellipsis-clamped so long backend messages cannot stretch the header).
Gate:      see F-27
Notes:     detail strings from useTtsStatus/status API are short diagnostics ("CUDA unavailable, falling back to CPU"); the chip's tone colors are AA-checked by the F-22 contrast test.

## F-29 — Palette buttons → radiogroup                   [phase 4] 2026-09-20
Test:      SettingsView.test.jsx :: "models palette+mode as one radiogroup with named options (F-29)", "arrow keys move palette selection (F-29)", "clicking a palette option still selects it"
Failed as: getByRole('radiogroup', {name:'Color palette and mode'}) — the old markup was role="group" aria-label="Color palette" of aria-pressed buttons named only by title.
Changed:   SettingsView.jsx — role="radiogroup" renamed to what it controls; options are role="radio" with aria-label "Violet Dusk, dark", aria-checked, roving tabIndex (one tab stop), Arrow*/Home/End move selection with selection-follows-focus and post-update focus restore.
Gate:      see F-27
Notes:     SUPERSEDED PREMISE: the F-14-era test "offers every palette in both modes with the active one pressed" asserted the aria-pressed contract the finding orders replaced; its substance (one active option, click selects) is carried by the three new tests. The real audit run (below) caught the radiogroup rendering with 1 tabbable radio — verified live.

## F-30 — Reduced motion deleted the loading vocabulary  [phase 4] 2026-09-20
Test:      styles/reduced-motion.test.js :: "reduced-motion loading fallbacks (F-30)" — progress keeps a visible static bar, waveform renders static full-height, spinner stops
Failed as: base.css/controls.css contained no prefers-reduced-motion fallbacks for .loading-progress / .loading-waveform / .spinner (blanket kill rule only).
Changed:   controls.css — explicit reduce block: .spinner/.spin animation:none (all current uses sit next to a text label: "Adding…", "Opening Voice Studio…", verified by grep); .loading-waveform span animation:none + scaleY(1); .loading-progress::after animation:none + width:45% static indeterminate stub.
Gate:      see F-27
Notes:     The blanket base.css rule is kept (right default); .skeleton shimmer stopping is acceptable — the placeholder fill remains.

## F-31 — Focus geometry rewrite; no forced-colors       [phase 4] 2026-09-20
Test:      styles/focus-and-forced-colors.test.js :: "focus ring geometry (F-31)", "forced-colors support (F-31)"
Failed as: the :focus-visible rule body contained `border-radius` (5 occurrences matched, assertion failed); BASE_CSS had no @media (forced-colors: active).
Changed:   base.css — border-radius dropped from :focus-visible (outline follows the element radius natively); forced-colors block: outline: Highlight for focus, CanvasText outline for .is-active/.current/[aria-current=page] so fill-only state survives High Contrast flattening.
Gate:      see F-27

## F-42 — Settings outside nav; RTL-unsafe safe-area     [phase 4] 2026-09-20
Test:      Sidebar.test.jsx (new file) :: "wraps every nav control, Settings included, in a nav landmark", "the secondary nav is also a navigation landmark"; styles/safe-area.test.js :: "mobile sidebar safe areas (F-42)"
Failed as: getByRole('navigation', {name:'Secondary'}) did not exist (footer was a div — Settings matched no nav at all); SHELL_CSS contained no env(safe-area-inset-right) (the 3-value padding shorthand reused inset-left for both sides).
Changed:   Sidebar.jsx (.sidebar-footer → <nav aria-label="Secondary">), shell.css (padding-block/padding-inline with each inset explicit), reader.css + shell.css + studio.css (margin-left/right: auto → margin-inline-start/end — .reader-nav-more, .theme-selector-mode, .studio-section-toggle, .studio-section-kicker).
Gate:      see F-27
Notes:     The RTL audit item ("verify nothing else assumes LTR") was completed by inspecting all 4 physical auto-margin sites and converting them; remaining physical properties (borders, text-align:left on rows) are content-side, not reading-direction side.

## Phase 4 exit gate — audit_a11y.py                     [phase 4] 2026-09-20
Running the planned baseline exposed the harness itself was broken three ways (the plan file itself warns axe will catch things the review did not enumerate — here the harness hid even the enumerated ones):
  1. Routes: App.jsx derives its view from localStorage, never the URL path — goto'/settings rendered HOME. All five "routes" had been scanning the same surface. Fixed with a route→(view,url) map (reader reached via ?book= deep link).
  2. Stub: the client fetches /api/voices/ (trailing slash); exact-match stub fell to {} → VoiceSettings setVoices(undefined) → the whole Settings route crashed behind the ErrorBoundary, and a crashed page reports zero axe violations. Fixed path normalization; /settings now genuinely renders and scans clean.
  3. Traversal: checked activeElement BEFORE the first Tab (→ body → zero stops recorded — the "keyboard traversal" silently did nothing); after adding a pre-loop press it double-pressed (the loop's trailing press remained) and recorded every other control. Fixed; verified against a live probe: all 10-11 tabbable controls per route, in order.
Result: 5 routes × light/dark = **0 axe violations**. Traversal coverage recorded in a11y-baseline.json.
Remaining manual item: NVDA smoke of the toast/live regions and visual focus-indicator + forced-colors spot check — not runnable in this environment; DOM/CSS contracts are test-covered.
App-layer findings the fixed audit caught that the review missed: unlabeled `.file-input` on Home + Library (aria-label added — same pattern the Reader already used); `role="list"` containing the `role="status"` empty state in StudioProjectSidebar (empty state moved outside the list). Both were live-broken, not polish; no new FINDINGS.md ids were invented for them (covered by F-22..F-31's phase acceptance).

## Gate status note — backend pytest (environment)       [phase 4] 2026-09-20
`python -m pytest tests -q` currently fails 11 tests (test_tts_lifecycle ×10, test_voice_conversion ×1) IN THE FULL-SUITE RUN, deterministically. Proven pre-existing and unrelated to 2.8.1: a clean worktree of 766698a AND of 4524079 (the pre-remediation baseline the whole plan was written against) reproduces the identical 11 failures; the same files pass in isolation (71 passed). Cause: order-dependent state in the TTS suite plus missing local model weights on this machine (`backend/services/data/models/en` is untracked/gitignored and absent; README: weights are installed by the first-run payload). LOG entries for phases 1–3 claim "pytest OK" for partial runs only — the full-suite gate was green on a different machine state.
ACTION: 2.8.1 phases 4-6 proceed with the pytest gate recorded as "no new failures vs baseline (463 passed / 11 pre-existing failures / 1 skipped)"; the suite-hygiene failure is deferred as F-45 (see FINDINGS.md Deferred).

---

Phase 5 (state, theme, architecture) — 2026-09-20. All seven findings written failing-first in the normal order.

## F-32 — Refs written during render                      [phase 5] 2026-09-20
Test:      frontend/src/hooks/ref-hygiene.test.js :: "component files never assign `*Ref.current` at render-body indent" (scans every .jsx under src/)
Failed as: listed exactly the four sites the finding names (Reader narrationRef/sleepRef/openLibraryBookRef, Modal onCloseRef) PLUS two the review did not enumerate: Transcript.jsx:71-72 currentWordValueRef/interactionRef — same pattern, same file-level acceptance.
Changed:   each moved into a useEffect (deps where meaningful, commit-order refresh for the cycle-bridging refs). Declaration cycles kept (restructuring narration↔lifecycle was beyond a hygiene fix; the finding allows the effect form).
Gate:      lint OK / vitest OK(537) / build OK / static-sync OK / pytest no-new-failures (464 passed, same 11)
Notes:     StrictMode was already on (main.jsx) — no double-invocation artefacts after the move; the whole-suite vitest ran under StrictMode unchanged.

## F-33 — useUserConfig: one copy, null-safe              [phase 5] 2026-09-20
Test:      hooks/useUserConfig.shared.test.jsx (3 tests) + LibraryView.test "disables book actions, without crashing, until config has loaded (F-33)"
Failed as: UserConfigProvider did not exist (import undefined → render threw); LibraryView trigger was enabled with config null and getVoiceId threw `config.voice_id` on activation.
Changed:   UserConfigProvider added and mounted in main.jsx beside ToastProvider; useUserConfig() returns the shared value under a provider and keeps a per-instance fallback for standalone mounts (same escape-hatch shape as Toast's). loadError state added and surfaced in SettingsView as a warning banner. LibraryView: config?.voice_id / config?.language_id + menu trigger disabled until config resolves (title explains 'Loading settings…'). Stale comment (lines 15-19) rewritten to describe the provider contract.
Gate:      see F-32
Notes:     Pre-existing useUserConfig.test.js (direct-hook fallback path) untouched and green.

## F-34 — False data-loss warning after a successful save [phase 5] 2026-09-20
Test:      BookSession.test.jsx :: "a successful save clears the dirty guard via onSaved (F-34)" and "a failed save does NOT clear the dirty guard (F-34)"; App.test.jsx :: "does not warn about unsaved work after a successful scan save (F-34)"
Failed as: onSaved prop never invoked (import succeeded but the callback did not exist); App-level test: the Leave-scan dialog still appeared after a successful save.
Changed:   BookSession calls onSaved?.() after a successful importPreparedBook (failure path untouched); App wires it to setScanDirty(false). openBook decision documented under F-39.
Gate:      see F-32

## F-35 — Follow-system theme, live OS updates, self-healing validation [phase 5] 2026-09-20
Test:      useTheme.test.js :: "theme: system mode and validation (F-35)" (7 tests: fresh install follows OS without persisting; system tracks OS changes; explicit choice survives OS changes; toggle converts system→explicit; corrupt values self-heal AND rewrite storage; legacy colon keys migrate; system swatches exist); SettingsView.test :: "the System option is a first-class choice (F-35)" (+ F-29 tests updated to the 15-radio contract — superseded premise); tests/test_theme_bootstrap_externalized.py :: test_theme_boot_validates_stored_values_and_supports_system
Failed as: mode had no 'system' value at all (fresh install computed the OS value and the mount effect PERSISTED it, killing follow-system); no matchMedia listener existed (OS switches never propagated — the tracking test proved the absence: listener list empty); garbage storage ('not-a-palette'/'chartreuse') was written straight to data-* attributes with no validation; getByRole('radio', {name:'Aurora Ink, system'}) found nothing.
Changed:   useTheme.js rewritten: mode ∈ {system,light,dark}, default system, effectiveMode derived, matchMedia subscription in system mode, choice-driven persistence (defaults never written; sanitization rewrites once at mount), resolveStoredTheme exported. PALETTES gain a gradient `system` accent. theme-boot.js rewritten with the same whitelist + 'system' semantics + unified legacy key order (paper/blue/sage/plum/sand; mode keys bookvoice.mode → bookvoice:mode → bookvoice.theme on both sides). SettingsView adds the System column (15 radios). TopBar switches to effectiveMode for icon/label.
Gate:      see F-32
Notes:     The plan's two MANUAL exit-gate items (toggle OS theme live; corrupt storage reload) are covered by the automated F-35 tests (setSystemDark dispatch + corrupt-value mount) rather than a manual pass — recorded here honestly: no real-OS flip was performed.
Notes:     jsdom in this project has NO window.matchMedia (the guards in useTheme predate this); the tests define/delete it explicitly.

## F-36 — Progress visibility flush missing               [phase 5] 2026-09-20
Test:      Reader.test.jsx :: "flushes pending reading progress the moment the tab hides (F-36)"
Failed as: dispatchEvent(visibilitychange) left updatePreparedProgress uncalled with the pending page-2 snapshot (the comment promised a flush that was never written).
Changed:   Reader.jsx — pagehide + visibilitychange listeners mirroring useReaderProgress.js:99-110 (both events, same reasoning: iOS Safari vs desktop tab-close).
Gate:      see F-32

## F-39 — Silent deep-link miss                           [phase 5] 2026-09-20
Test:      Reader.test.jsx :: "explains a deep link whose book id is not in the library (F-39)"
Failed as: ?book=ghost-99 with a loaded library produced zero feedback (toast.error never called; silent empty reader).
Changed:   Reader toasts the miss once, naming the id. openBook: documented decision NOT to persist 'reader' (appSession rejects it by design; ?book= URL + Home's continue-card already own restore; a persisted bare reader would reopen an empty shell).
Gate:      see F-32

## F-40 — View transition timing + title/content desync   [phase 5] 2026-09-20
Test:      App.test.jsx :: "keeps the top-bar title synced to the displayed view during the fade (F-40)"
Failed as: mid-fade the title read 'Library' while the stage still rendered Home (title derived from `view`); swap depended on a JS timer duplicating the CSS 200ms.
Changed:   App.jsx — the swap is driven by transitionend (opacity, stage-targeted) with a 600ms safety-net for the case where no event ever fires; reduced motion needs no special case because base.css forces 0.01ms durations → the event arrives immediately; contextTitle derived from displayView. The hardcoded 200 duplicate is gone.
Gate:      see F-32
Notes:     Load flakes: the 84-file parallel run once failed `jumps to a typed page number` (1.1s against the 1s default waitFor poll budget under 84-file load); the shared findPageText helper got a 4s budget — assertion unchanged. Both suspect tests pass in-file and in full-suite reruns.

## Phase 5 exit gate
F-32..F-36, F-39, F-40 verified in FINDINGS.md. Regression tests F-33 + F-34 present (plan minimum) plus per-finding tests for the rest. Manual items (OS-theme flip, corrupt-storage reload) covered by automated equivalents — see F-35 notes; visual focus/forced-colors spot checks remain un-run in this environment. Full suite: lint 0/0, vitest 84 files / 537 tests green, build OK (entry 341.9 KiB ≤ 350 budget), static-sync OK, pytest at baseline parity (464 passed / same 11 pre-existing failures / 1 skipped, +1 new bootstrap validation test green). axe: 0 violations, 5 routes × 2 modes.

---

Phase 6 (cleanup and guardrails) — 2026-09-20. Final phase.

## F-11 — Orphan CSS sweep + the inverse parity guard          [phase 6] 2026-09-20
Test:      styles-parity.test.js :: "every CSS class selector is referenced from app source (F-11 inverse)" (NEW — the fail-first instrument itself)
Failed as: the fresh post-Phase-5 sweep listed 83 orphan names across 5 stylesheets (the review's 89, mostly confirmed; drift = classes phases 2-5 revived or deleted). First pass also surfaced 5 collateral deletions the sweep script over-reached on (mixed live+dead selector lists: `.file-input`/`.file-upload`, `.zoom-control`/`.zoom-label`, `.record-section`/`.history-list`, `.studio-loading`–`.studio-empty`–`.studio-fatal`, and a shell.css `@media (prefers-reduced-motion)` nested rule the line-parser missed) — each restored/removed surgically; test green only at zero.
Changed:   ~340 lines of dead CSS deleted (PdfViewer layout/toolbar/upload/transcript/reading-options/prepared-library, theme-selector dropdown + settings-dropdown, studio onboarding blocks, `.skeleton--line`, `.control-btn`, `.btn-large`, `.field-label`, `.voice-creation`, `.loading-progress` + its `@keyframes bv-progress` + F-30 fallback, dead `@media 1024px` PdfViewer block, `.mode-indicator` reduce rule). Inverse test strips CSS comments before scanning (prose must not mask orphans) and carries a reasoned allowlist (react-pdf runtime ×5, `toast-${type}` compositions ×4). `--radius-full` merged into `--radius-pill` (see F-44). `--transport-height` was already deleted by F-10 with its own guard test ✓. `'compact'` allowlist entry: already gone (F-16 collapsed the alias in phase 3; re-verified — ALLOWLIST holds only the two react-pdf names). The no-op `@media 480px .shortcuts-grid` rule deleted (the `.shortcut-row` collapse in the same block does real work and stays). Transport rule dedup was done by F-22 in phase 4; re-verified no `.transport-*`/`.playback-transport` base rule is defined twice.
Gate:      lint OK / vitest OK (85 files, 543 tests) / build OK (entry 330.1 KiB ≤ 350 — the sweep is also why the bundle dropped ~12 KiB) / static-sync OK / pytest baseline parity (467 passed / same 11 / 1 skipped) / axe 0 violations ×5 routes after rebuild

## F-37 — Vestigial code and stale comments                   [phase 6] 2026-09-20
Test:      styles-parity inverse (comment-stripping keeps docs honest) + existing suites as regression; PdfViewer-reference clearance verified by `findstr /S "PdfViewer" src`
Failed as: (guards rather than red-first — the deletions are removals) Reader.jsx:97-98 userTouched* refs confirmed never set: Reader has no voice/language picker (checked post-phase-2 per the finding's instruction — VoiceSettings never entered the Reader; CONTRACT.md's "voice pickers … later slices" agrees).
Changed:   vestigial refs + their branches removed (apply-once via configAppliedRef kept — the BookSession pattern in configApply.test.js is real and untouched); comment claims corrected: PlaybackControls "see PdfViewer wiring" (deleted), Reader deep-link/ref/flag comments (3 PdfViewer pointers rewritten self-contained), useReaderNarration playlist-origin pointer + port-lineage ×2, useKeyboardShortcuts/useReaderTransport/usePreparedLibrary/useReaderZoom lineage phrasing → "pre-migration viewer" (+ :55 behavior note), controls.css mobile-transport "media keys / other hosts" rationalization replaced with the honest wording (±10 s and rate are simply dropped at phone widths; their shortcuts remain for hardware keyboards — the finding's "resolved by Phase 3" premise was checked and the popover does NOT hold them, so the comment says what is true), reader.css PdfViewer-era banner removed with its dead rules. CONTRACT.md + PARITY.md carry an explicit "Superseded note (2.8.1, F-37)" banner declaring every remaining `PdfViewer` mention historical (slice 0.5 shipped in 2.7.x); CONTRACT.md's stale "useUserConfig: Not yet consumed" table row corrected. shell.css:478's "pointer: coarse rules apply" claim verified TRUE now (phase 3 added them) — kept. useUserConfig.js stale comment fixed via F-33; Reader visibility-flush comment now matches reality (F-36).
Gate:      see F-11

## F-43 — Backend hygiene (non-logging tasks)                 [phase 6] 2026-09-20
Test:      NEW tests/test_main_startup_hygiene.py (3 source-contract guards; `import main` executes CUDA init + TTS thread setup, so a functional test of module import is not safe in the suite)
Failed as: all 3 red against HEAD main.py (verified via stash cycle: 3 failed → fix → 3 passed).
Changed:   `STATIC_DIR = (Path(APP_DIR) / "static").resolve()` (was CWD-relative — launching from elsewhere degraded to the "Frontend not built" JSON root despite a present bundle); `voices.seed_default_voices()` moved from import time into `lifespan` beside the other startup side effects, same error-swallow-with-print (until the logging PR); `style-src 'unsafe-inline'` annotated as deliberate+unavoidable (React inline styles, react-pdf).
Gate:      see F-11
Notes:     The `print()` → `logging` migration stays DEFERRED as the plan itself prescribes ("its own PR", ~50 call sites; FINDINGS "Deferred"), now additionally blocked behind F-45's suite-hygiene finding on this machine (a logging-config change cannot be fully gated here while the TTS suite state is unknown). F-43 is marked `partial (F-45 log PR)` in FINDINGS.md rather than verified — the honest row.

## F-44 — Miscellaneous                                       [phase 6] 2026-09-20
Test:      PdfStage.test.jsx :: "coalesces resize bursts into a single pending measure per frame (F-44)"; BookSession.test.jsx :: "history buttons declare type and save titles carry a time stamp (F-44)" + existing filename test updated to the stamped regex (superseded premise: it asserted the old date-only name); LibraryView.test.jsx :: "renders rows without a placeholder-fraction when the total is unknown (F-44)"; NEW styles/transport-scrubber.test.js :: "scrubber geometry derives from tokens (F-44)"
Failed as: 5 observation callbacks each produced a synchronous setPageWidth (pending rAF queue stayed empty → size 0 ≠ 1); `.history-item` had no `type` attribute; file name matched date-only `\d{4}-\d{2}-\d{2}\.txt`, rejecting the new stamp regex; unknown-count rows rendered "3/— narrated" (the `—` assertion red); controls.css carried `margin-top: -7px` and no `--scrub-track-h/--scrub-thumb-size`.
Changed:   PdfStage ResizeObserver → cancel/re-request per frame (one measure per frame, latest clientWidth; cleanup cancels the pending frame); `.transport-scrubber` geometry vars + derived `(track − thumb) / 2` centering (thumb/track/radius all reference the vars — sizes can no longer drift); `--radius-full` deleted in favour of `--radius-pill` (tokens.css + reader.css ×3 + PreparationProgress.jsx); history buttons `type="button"`; save titles gain a `YYYY-MM-DD-HHMM` stamp (no `:` → file-name safe); PreparedBookRow says "3 narrated" when the total is unknown.
Notes:     Toast dismiss `type="button"` was already shipped in F-26 (phase 4) — verified, no change. 480px rule under F-11.

## Test-suite stability (Phase 6 investigation — NOT a code fix)
Full 85-file suite runs intermittently failed one timing-sensitive test per run, always a *different* one (Reader `jumps to a typed page number` once, Reader `flushes … tab hides (F-36)` once, then two VoiceStudio tests), each green in isolation and in-file, and green in surrounding full runs. The box measurably slowed during the session (same pytest suite: 62 s → 124 s → 131 s) with no orphan processes attributable to this session (checked: every heavy node process is a separate Qwen Code CLI session; chrome instances are the user's). Attempted remedy — raising RTL's global `asyncUtilTimeout` to 5 s in setupTests.js — made two consecutive full runs fail the VoiceStudio value assertions instead, so it was REVERTED to the original 1 s default; the Reader-local 4 s helper override from phase 5 was likewise folded back. Final state: default timeouts, two consecutive clean 85-file full runs, plus one earlier clean run before the experiment. The residual flakes are environmental (CPU starvation of debounced autosave/store writes past their poll windows), left as-is deliberately: no assertion was weakened, no test skipped, and the machine, not the suite, is the variable.

## Phase 6 exit gate
- Orphan sweep regenerated post-Phase-5: 83 orphans, deleted, inverse guard green (zero allowed).
- Inverse parity assertion added and green; comments stripped from its scan so prose can't mask orphans.
- `'compact'` allowlist entry: already removed in phase 3 — re-verified.
- No live PdfViewer claims remain in `frontend/src` (code comments rewritten; CONTRACT.md/PARITY.md explicitly banner-marked historical).
- Bundle: 330.11 KiB ≤ 350 (sweep shed ~12 KiB).
- Full suite: lint 0/0 · vitest 85 files green (twice consecutively after the timeout experiment was reverted) · build OK · static-sync OK · axe 0 violations ×5 routes ×2 modes · pytest baseline parity (467 passed / same 11 pre-existing / 1 skipped; +4 new green tests this phase).
- FINDINGS.md: every row verified, invalid, deferred (F-08 partial), or partial-with-written-reason (F-43 → F-45). Nothing silently open.

