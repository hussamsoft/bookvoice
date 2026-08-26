# BookVoice UI Redesign Plan — "Vellum & Signal"

Goal: raise the frontend to world-class polish (Linear/Things-grade restraint and craft) without
regressing any of the 40 functional invariants documented in the 2026-08-25 audit. Baseline: 2.4.0 tree.

## Verdict on current UI

Strong bones, unfinished skin. Token doctrine (semantic-only consumption, border-over-shadow,
dual theme) is documented and enforced by `styles-parity.test.js`. What's missing: typographic
identity, motion design, mobile-grade layout, one accessibility defect in the core reading
surface, and accent-color semantics (one slate means hover, active, live, AND narration).

## Direction

**Vellum & Signal** (recommended over "Control Room"): the product's center of gravity is long,
quiet reading/listening. Warm paper surfaces; color is spent entirely on *the voice* — a single
Signal hue appears only when narration/recording is live. Interface holds still; voice moves.

- Type: Fraunces (display, heroes/empty-states only), IBM Plex Sans (UI), Literata (reading),
  Noto Naskh Arabic subset when `lang=ar` (today Georgia silently falls back for Arabic),
  Plex Mono (timecode). Scale extends past today's 28px ceiling: 12/13/14/16/20/26/34/44.
- Palette light: Paper #F7F5F1, Card #FFFFFF, Ink #211F1B, hairlines rgba(33,31,27,.10);
  Action (interactive) #3A5A78; **Signal (live audio only)** #2C5D5A; Live-red #A03A2E reserved
  for recording/destructive.
- Dark ("Night listening", first-class): warm-black #161513/#1E1C19, Ink #ECE9E3, Signal #7FB8AE,
  Action #9DBBD6; defaults from `prefers-color-scheme`; dynamic `<meta name="theme-color">`.
- Geometry: radii 6/10/14/pill; elevation doctrine unchanged (borders separate, shadows float);
  add one `--shadow-pop` level for menus/sheets only.
- Motion: ease-out-quart 120–200ms. One choreographed moment: pressing Play — transport settles,
  first word highlight sweeps in as an underline-grow; nothing else moves. Reduced-motion keeps
  state changes instant (existing kill switch in base.css stays).
- Signature: the **Signal underline** — one continuous device shared by reader word-highlight,
  studio waveform selection, recorder meter, always in Signal hue.

## Framework decision

Keep and evolve the vanilla-CSS token system. Do NOT adopt Tailwind v4 now:
1. styles-parity.test.js exists precisely because the last design-system swap orphaned ~17 classes;
   a utility rewrite re-runs that migration mid-release cycle.
2. Theming here is semantic-token remapping on one attribute — utility composition fights it.
3. Bundle math: entry 248.6 KiB vs 350 KiB budget; headroom goes to subsetted variable fonts
   (~40–80 KiB), not a utility layer. Vite already splits per-mode CSS.
Evolution: tokenize z-index ladder (currently implicit 3/10/60/80/90), consolidate breakpoints
(720px / 60rem / 1024px) into documented tokens, add control-height tokens, assert all three in
the parity test.

## Phases

### P0 — Foundations (tokens v2)
Files: `styles/tokens.css`, `styles/base.css`, `styles/styles-parity.test.js`, `index.html`.
- Add Signal/Live roles alongside Action; paper/ink remap both themes; new type scale + font
  families (self-hosted subsets: latin + arabic).
- Z-index ladder, breakpoint, control-height tokens; parity test asserts them.
- Acceptance: parity test green; no component CSS hardcodes hex outside on-media overlays;
  bundle baseline updated in `tasks/bundle-baseline.json`.

### P1 — Correctness & accessibility floor
Files: `components/TranscriptWord.jsx`, `components/Transcript.jsx`, `reader.css`,
`components/ui/StatusBanner.jsx`, `ReaderBanners.jsx`, `BookSession.jsx`, `TitleBar.jsx`,
`controls.css`.
- Fix keyboard trap: drop `role="button" tabIndex={0}` per word (300 tab stops/page today);
  container becomes one focus target with arrow-key word navigation; click-to-pronounce kept.
- Lift past-word de-emphasis off ~2.4:1 contrast (gray-400 on white).
- Add missing `warning` tone mapping to StatusBanner; demote CPU-slowdown banners from error red.
- Dark-mode completeness: `prefers-color-scheme` default (hard 'light' today), dynamic theme-color.
- Pressed states (`:active` rules: zero today) on primaries.
- Acceptance: tab order reaches content past transcript in ≤3 stops; axe-style manual pass clean;
  CPU banner renders amber in both themes.

### P2 — Reader surface (the flagship)
Files: `components/PlaybackControls.jsx`, `PdfViewer.jsx`, `hooks/useAudioTransport.js` (wire-up
only), `components/reader/ReaderToolbar.jsx`, `ReadingOptionsPanel.jsx`, `reader.css`.
- Scrub/seek bar in the narration transport — plumbing already exists (`seekTo`,
  playlist global timeline); it is only wired to word clicks today. Biggest single usability win.
- Regroup ReaderToolbar into labeled clusters (move · view · track · find) + overflow menu;
  single home for Edit/Translate (currently duplicated in TranscriptColumn and ReadingOptionsPanel).
- Reading options become a popover (desktop) / bottom sheet (mobile) instead of always-open grid.
- Skeletons for page/text/model-warming loads replacing spinner-only vocabulary.
- Prepared-library list: remove `slice(0, 5)` dead-end (books 6+ unreachable) → scroll area.
- Acceptance: seek works mid-chunk-boundary across the whole-book timeline; toolbar fits one row
  at 1280px without wrapping; library reachable at any count.

### P3 — Studio skin
Files: `VoiceStudio.jsx`, `Studio*.jsx`, `studio/MediaWorkbench.jsx`, `studio.css`.
- Scoped `--density` multiplier: studio one notch denser than reader.
- Replace native `<select>`/`<progress>` in primary flows with token-styled equivalents
  (rate, sleep, delivery sliders keep native range with styled track).
- Sticky job card: dock to a rail instead of floating mid-content with overlay shadow.
- Waveform/recorder/meter adopt the Signal underline language.
- Virtualize or cap StudioNarration's per-word correction buttons (unbounded DOM up to 200k chars).
- Acceptance: no native select visible in NARRATION flow; job card never overlaps script editing;
  200k-char script scroll stays 60fps.

### P4 — Mobile pass (phone sessions)
Files: `reader.css`, `shell.css`, `controls.css`, `studio.css`, `index.html`.
- Fixed bottom transport in thumb zone (scrub + play/pause + sleep) on ≤720px.
- Touch targets ≥44px (compact buttons are ~26px tall today).
- `env(safe-area-inset-*)` consumed everywhere `viewport-fit=cover` matters (declared, never used).
- Bottom-sheet pattern shared with P2 options panel.
- Acceptance: full read→narrate→export loop completable one-handed at 390px width.

### P5 — Motion & feedback discipline
Files: `Toast.jsx`, `shell.css`, mode components.
- Toast discipline: stop per-toggle success spam (SettingsPanel fires on every toggle), coalesce
  repeats, add enter/exit animation.
- Dialog choreography (fade+scale 0.98→1, 140ms); Play-press signature moment.
- Navigation feedback stops using toasts ('Scan a page to start.' on every camera switch).
- Adopt or delete `ui/Button.jsx` (declared single implementation, zero render sites) — the
  redesign adopts it as the real primitive; delete `.btn.compact`/`.btn.btn-compact` duplication;
  replace surviving `window.confirm` (VoiceSettings voice deletion) with ConfirmDialog.
- Acceptance: reduced-motion audit passes; no toast on pure navigation; Button used by all
  primary actions.

## Must-preserve invariants (condensed)

Full 40-item list lives in the audit transcript. Non-negotiables: resume-or-fresh dialog semantics;
word-level sync state machine (playing/paused/idle behaviors); gapless chunked streaming incl.
buffering-as-pause; sleep timer modes incl. end-of-chapter + fire-once; Media Session handlers +
cleanup; bookmarks/search/jump; RTL correctness (document-level dir/lang swap en↔ar);
device-scoped identity header/cookie; capability gating (localFileActions/authRequired);
consent gates on every cloning path; recorder review-before-commit; immutable output history;
job reconnect/recovery UX; legacy-project claim copy; sidebar phone disclosure behavior.

## Risks

- Font loading adds FOUT risk → self-host, `font-display: swap`, subset latin+arabic only.
- styles-parity.test.js must evolve with tokens in the same PRs or it will block honestly.
- PdfViewer.jsx is a 2,394-line monolith; P2 refactors should extract toolbar/transport state
  into hooks rather than grow the file.
- MSI bundle budget: track after P0 (fonts) — update tasks/bundle-baseline.json each phase.
