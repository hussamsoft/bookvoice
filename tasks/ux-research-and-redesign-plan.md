# BookVoice UX Research & Redesign Plan
> Goal: transform the interface from "functional but cluttered/confusing" into a calm, legible, world-class experience without regressing any functional behavior.

---

## 1. Diagnosis — what's actually wrong today

Walking the surface, the bones are solid (token system, semantic color, dual theme, accessibility scaffolding). The pain is **presentation density** and **missing spatial grammar**. Specific failures:

### 1.1 Navigation & wayfinding
- **Mode switcher is a triplet of equal-weight buttons** with icon + title + subtitle each. Three large cards compete for attention; nothing tells you where you are at a glance beyond a thin underline. The labels ("Read a book", "Scan a page", "Voice Studio") describe *features*, not *user goals* — a new user has to read all three subtitles to understand the difference.
- **No persistent orientation cue.** The titlebar is just "BookVoice" + sparkle + theme + settings. No breadcrumb, no mode indicator. When you're deep in a Studio project, there's no sign of where you are in the app.
- **Studio has two separate "start" surfaces** (StudioStart screen + StudioProjectSidebar) that both show "create project" + "recent projects" — duplicated entry points that confuse the mental model.

### 1.2 Clutter & density
- **ReaderToolbar** packs 4 labeled groups + overflow into a single row: prev/next/page-jump/return-to-narrated + zoom + follow/bookmark + search + more. At 1280px this wraps. Every control is visible at once — no progressive disclosure of the *primary* path.
- **PlaybackControls** is a single strip: Stop / Back10 / Play / Forward10 / scrubber / time / rate / sleep / page / status / error. The primary action (Play/Pause) competes visually with 8 siblings.
- **ReadingOptionsPanel** opens a popover with VoiceSettings (full selector + refresh + delete), Language, Page tools, and Whole book — four conceptual groups in one flat panel with no visual separation.
- **StudioSettings** exposes Pace/Expression/Temperature/Guidance/Seed in a 2-column grid of identical-looking range+number controls. Every control has the same visual weight; nothing signals "these are advanced / auto is fine."
- **StudioNarration** stacks: VoiceCloner + Settings + Script editor + Latest performance + Outputs — five major sections with no hierarchy. The "Step 1 / Step 2" kickers help but the sections themselves are undifferentiated blocks.

### 1.3 Spacing & typography
- **Type scale tops out at 44px** but the actual hierarchy in use is flat: h1 (app title), h2 (section), h3 (sub-section), h4 (panel title) — most surfaces use h3/h4 for everything, so headings don't create scan lines.
- **Line-height is 1.55 everywhere** — body, UI, headings. Headings need ~1.2 to feel grounded; body benefits from 1.6.
- **Spacing between sections is inconsistent.** Some use `--space-4`, others `--space-5`, with no rule tying space to semantic distance. Studio sections run together with hairline separators only.
- **Text in buttons is 14px** (`--text-md`) with icons at 15–16px — fine, but secondary/tertiary actions use the *same size* as primaries, so nothing recedes.

### 1.4 Motion & feedback
- **Toast spam**: SettingsPanel fires a success toast on *every* toggle. Navigation events ("Scan a page to start") use toasts instead of inline status.
- **No pressed states** on primary buttons (`:active` rules are zero). Users get no tactile confirmation.
- **Mode switch is instant** — no transition, no spatial continuity. The whole stage swaps in place.
- **Loading states are vocabulary-poor**: spinner-only or skeleton-only, no contextual "warming model / preparing page / narrating" differentiation.

### 1.5 Visual language gaps
- **Signal hue (teal) is underused.** It's defined for "narration/live audio" but the Play button is slate Action, the live word highlight is a pastel underline, and the recording meter is the only place Signal shows up strongly. The "voice moves, interface holds still" idea from the existing redesign plan is *defined* but not *executed*.
- **Cards vs. flat surfaces are undefined.** Some sections are white cards on paper, others are flat with hairlines, others are flat with no separator. No elevation doctrine beyond "borders separate, shadows float."
- **Empty states are inconsistent.** Some are centered cards with icon + title + hint; others are plain `<p>` text. No shared pattern.

---

## 2. Principles for the redesign

These are the non-negotiables that every change must serve:

1. **Calm surface, clear path.** The interface should hold still. One primary action per view. Secondary actions recede until asked.
2. **Progressive disclosure by default.** Show the happy path; hide the rest behind "more", accordions, or hover. Power features stay reachable — just not shouting.
3. **Spatial consistency = trust.** Same relationship, same space. Section spacing, card padding, and inline gaps follow a single rule, not ad-hoc values.
4. **Typography does the heavy lifting.** Headings create scan lines. Weight and size differentiate before color has to. Color is reserved for meaning (Signal = voice is live, Live = destructive, Action = interact).
5. **Motion is feedback, not decoration.** Every transition answers a question: *where did this come from? where did I go? did my click register?* Reduced-motion kills all of it cleanly.
6. **One voice, one grammar.** Empty states, banners, dialogs, and toasts share a single compositional pattern: icon + title + one-line explanation + (optional) action.

---

## 3. Layout & navigation redesign

### 3.1 App shell — from "big header + stage" to "persistent rail + focused stage"

**Current:** TitleBar + mode-switcher triplet sit in a tall header above the content. The header is ~120px of chrome before any real content.

**Proposed:**
- **Collapse the header to a single 56px bar.** Left: app mark + current mode (small, muted). Center: *contextual* title (book name in reader, project name in studio). Right: theme + settings.
- **Move mode switching to a compact segmented control** (3 segments, equal width, ~36px tall) — not cards. Each segment is icon + short label only; the subtitle moves to a one-line contextual hint *below* the control that updates with the selected mode. This alone cuts ~60px of vertical chrome and makes the switcher a *control*, not a *hero*.
- **Add a persistent "where am I" cue.** In reader: `Reading · <book name>`. In studio: `Studio · <project name>`. In camera: `Scanning · Page N`. This lives in the center of the titlebar — always visible, never competing.

### 3.2 Reader — separate *reading* from *controlling*

**Current:** Toolbar (4 groups) + PDF stage + transcript column + sticky transport. The toolbar wraps at common widths; the transport is a crowded strip.

**Proposed:**
- **Toolbar → two-tier.** Tier 1 (always visible, single row): page navigation (prev / page X of N / zoom-fit) + Play/Pause (the *one* primary action). Tier 2 (overflow "…" popout): search, follow-narration, bookmark, export, bookmark-jump. This makes the default row fit at 1024px without wrapping.
- **Transport → focused strip.** Play/Pause (large, 44px, Signal hue when playing) + scrubber + time on a *single primary row*. Rate, sleep, and page-label move to a *secondary row* that appears only when relevant (rate/sleep are persistent but visually muted — smaller, `--ink-muted` color).
- **Reading options → contextual, not a panel.** Voice + language stay as compact inline controls in the toolbar tier-1. "Whole book" actions (prepare, export) move to a single "Book actions" dropdown. The popover pattern is kept but the *contents* are decluttered — one thing, not four.

### 3.3 Studio — one entry, one hierarchy

**Current:** StudioStart (hero + create + recent) AND StudioProjectSidebar (create + recent) are two parallel entry points. Inside a project: 5 stacked sections with flat hierarchy.

**Proposed:**
- **Single entry surface.** The sidebar *is* the start screen: it shows recent projects + create at all times. Remove StudioStart entirely — its hero copy becomes the sidebar's empty state. This eliminates the "two places to do the same thing" confusion.
- **Project view → clear section rhythm.** Each workflow section (Clone, Settings, Script, Latest, Outputs) gets:
  - A **section header row**: kicker + title + (optional) action, separated by a hairline from the body.
  - **Consistent card surface**: white card on paper (light) / raised surface (dark), `--radius-md` corners, `--space-4` padding, hairline border. Sections are *visually separated cards*, not flat blocks.
  - **One primary action per section**, visually dominant. Secondary actions are `.btn.text` (ghost) and recede.
- **Settings → progressive.** Voice + language show as the visible "essential" row. Pace/Expression/Temperature collapse under "Advanced delivery" (collapsed by default). Guidance/Seed collapse under a second "Variation" disclosure. The grid only expands when the user asks.

### 3.4 Camera wizard — guided, not stacked

**Current:** Session header (title + step indicator + step label + VoiceSettings + banners) then content. The step indicator is small text; VoiceSettings is fully expanded inside the header.

**Proposed:**
- **Step indicator → a real stepper.** A horizontal 4-step tracker (Capture → Review → Read → Listen) with numbered dots and labels. Current step is Signal hue. This is the *first* thing the user sees — it answers "where am I, how many steps, what's next."
- **VoiceSettings → collapsed** into the header as a single "Voice: <name> ▾" pill; expands to the full selector on click. The header is no longer a dumping ground for controls.
- **Banners → inline, not stacked.** Model status is a single compact strip, not a column of full-width banners.

---

## 4. Typography & spacing system

### 4.1 Type scale (extended)

The existing scale (12/13/14/16/20/28/34/44) is good but underused. Add *semantic* roles and tighten heading leading:

| Token | Size | Line-height | Weight | Use |
|---|---|---|---|---|
| `--text-display` | 44px | 1.15 | 650 | App hero only (rare) |
| `--text-headline` | 28px | 1.2 | 600 | Mode / screen titles |
| `--text-title` | 20px | 1.25 | 600 | Section titles (card headers) |
| `--text-subtitle` | 16px | 1.35 | 500 | Subsection titles, prominent UI |
| `--text-body` | 16px | 1.6 | 400 | Reading text, body copy |
| `--text-ui` | 14px | 1.4 | 400 | Default UI (buttons, inputs, labels) |
| `--text-caption` | 13px | 1.4 | 400 | Kickers, hints, secondary labels |
| `--text-micro` | 12px | 1.35 | 500 | Badges, timestamps, tabular nums |

**Key change:** headings get `--leading-tight` (1.2–1.25), body gets `--leading-normal` (1.6). This alone creates scan lines.

### 4.2 Spacing rules (not values)

The 4px grid is already in place. The missing piece is *semantic* spacing:

- **Within a component** (button padding, input gaps): `--space-1` to `--space-2` (4–8px).
- **Between related items** (label above input, items in a list): `--space-2` to `--space-3` (8–12px).
- **Between sections** (card to card, major blocks): `--space-5` to `--space-6` (24–32px).
- **Between groups of sections** (reader → transport, toolbar → stage): `--space-6` to `--space-7` (32–48px).
- **Page margins** (edge of screen to content): `--space-5` (desktop), `--space-3` (mobile).

**Rule:** space between things that *belong together* is small; space between things that *don't* is large. The current code uses `--space-4` for both — that's the clutter.

### 4.3 Font weight as hierarchy tool

- **650** for display/headings (Fraunces variable axis; static faces round up).
- **500** for UI emphasis: active nav, section titles, button text, selected states.
- **400** for body and default UI.
- **Avoid 300** — it's too thin for UI text and fails contrast on warm paper.

---

## 5. Motion & feedback system

### 5.1 Duration & easing (extend existing tokens)

| Token | Value | Use |
|---|---|---|
| `--dur-instant` | 80ms | Toggles, switches, checkboxes |
| `--dur-fast` | 140ms | Button pressed, icon change, hover |
| `--dur` | 200ms | Panel open/close, mode switch, card appear |
| `--dur-slow` | 300ms | Page transitions, dialog open |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entries, reveals |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Transitions that reverse |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Playful moments (Play press, bookmark) |

### 5.2 Signature moments

1. **Play press (the big one).** Button scales 0.96 → 1 with `--ease-spring` over 200ms. Simultaneously, the first-word highlight sweeps in as an underline-grow (`--dur-word-underline`, `--signal` hue). The transport bar gets a subtle Signal-tint pulse. Nothing else moves.
2. **Mode switch.** The outgoing stage fades + translateY(-8px) over 150ms; the incoming stage fades + translateY(8px → 0) over 200ms with 50ms stagger. The segmented control's active indicator slides (not snaps) to the new segment. This gives spatial continuity — you feel the direction of travel.
3. **Panel open.** Scale 0.98 → 1 + fade, 140ms, `--ease-out`. Origin is the trigger point. This is already partially in Modal.jsx; extend to all popovers.
4. **Toast enter/exist.** Slide up + fade in (160ms); slide down + fade out (160ms). Already in shell.css — keep, but add a subtle scale 0.97 → 1 on enter.
5. **Pressed state.** Every button gets `:active { transform: scale(0.97); }` with `--dur-instant`. Instant tactile feedback.

### 5.3 Loading vocabulary (replace spinner-only)

- **Model warming:** skeleton block + "Warming up the narration engine…" (no spinner — skeleton implies structure coming).
- **Page preparation:** progress bar + "Preparing page 12 of 45…" (determinate, linear).
- **Narration generating:** animated Signal-hue waveform bars + "Narrating…" (indeterminate but branded).
- **Audio loading:** thin progress bar under the transport (not a spinner in the center).

### 5.4 Toast discipline (fix the spam)

- **Never toast on pure navigation.** Mode switch, page jump, tab change → no toast.
- **Never toast on every toggle.** SettingsPanel: remove per-toggle success toasts. The dropdown closing *is* the confirmation. Only toast on *error*.
- **Coalesce repeats.** Already implemented (COALESCE_MS). Keep.
- **Duration:** success 2.5s, info 3.5s, error 6s (or persistent if `duration=0`).

---

## 6. Visual language — cards, surfaces, and the Signal underline

### 6.1 Surface doctrine (define what's already implicit)

| Surface | Treatment | Use |
|---|---|---|
| **Paper** | `--bg`, no border, no shadow | App background |
| **Card** | `--surface`, 1px `--hairline` border, `--radius-md` | Sections, panels, dialogs |
| **Raised** | `--surface-raised`, `--shadow-pop` | Popovers, menus, focused cards |
| **Overlay** | `--shadow-overlay` | Modals, full-screen scrims |

**Rule:** flat sections on paper use *only* hairlines + whitespace to separate. Floating things (menus, popovers, dialogs) get `--shadow-pop`. Modals get `--shadow-overlay`. No card gets a shadow unless it floats.

### 6.2 The Signal underline (execute the existing idea)

The existing redesign plan defines Signal as "the voice" color but it's underused. Make it the *one* recurring accent:

- **Live word highlight** in transcript: animated underline-grow in `--signal`, 180ms.
- **Play button** when playing: `--signal` background (not slate Action). Paused = slate. This is the *only* place Signal appears as a fill.
- **Recording meter**: `--signal` bars (already in place).
- **Waveform selection**: `--signal` selection rect (already in place).
- **Step indicator (camera)**: current step dot is `--signal`.

**Result:** every time the user sees teal, it means "the voice is live here." Consistent, learnable, calm.

### 6.3 Empty states (one pattern)

Every empty state shares: `icon (28px, --ink-muted) + title (--text-subtitle, 500) + one-line hint (--text-caption, --ink-muted) + (optional) action button`. Centered in a `--radius-md` card with `--space-5` padding. No bare `<p>` empties.

---

## 7. Phased execution plan

### Phase 1 — Foundations: typography, spacing, surface tokens
**Files:** `styles/tokens.css`, `styles/base.css`, `styles/styles-parity.test.js`
- Add extended type scale tokens (`--text-display` through `--text-micro`, `--leading-*`).
- Add semantic spacing tokens (`--gap-inline`, `--gap-stack`, `--gap-section`, `--gap-group`) mapped to the 4px grid.
- Add surface tokens (`--surface-card`, `--surface-raised`) and elevation tokens.
- Add motion tokens (`--dur-slow`, `--ease-in-out`, `--ease-spring`).
- Parity test asserts: no component CSS hardcodes font-size, line-height, or spacing outside the token system.

**Acceptance:** parity test green; every component consumes semantic tokens; no hardcoded px for type/spacing.

### Phase 2 — App shell & navigation
**Files:** `App.jsx`, `TitleBar.jsx`, `shell.css`
- Collapse header to single 56px bar with contextual center title.
- Convert mode switcher from cards to segmented control.
- Add mode-specific contextual hint below the switcher.
- Mode switch transition (fade + slide, 200ms).
- Active segment slides (not snaps).

**Acceptance:** header height ≤56px; mode switch fits one row at 390px; contextual title visible in all modes; transition runs at 60fps.

### Phase 3 — Reader declutter
**Files:** `ReaderToolbar.jsx`, `PlaybackControls.jsx`, `ReadingOptionsPanel.jsx`, `PdfViewer.jsx`, `reader.css`
- Two-tier toolbar: primary row (nav + play) + overflow popout.
- Focused transport: primary row (play + scrubber + time) + muted secondary row (rate, sleep, page).
- Reading options: inline voice/language in toolbar; "Book actions" dropdown for whole-book.
- Section spacing: cards for transcript, toolbar, options — separated by `--gap-section`.
- Play button turns Signal hue when playing.

**Acceptance:** toolbar fits one row at 1024px without wrapping; transport primary row has ≤4 visible elements; reading options popover has one conceptual group visible at a time.

### Phase 4 — Studio hierarchy
**Files:** `VoiceStudio.jsx`, `StudioStart.jsx`, `StudioProjectSidebar.jsx`, `StudioNarration.jsx`, `StudioSettings.jsx`, `studio.css`
- Remove StudioStart; sidebar is the single entry surface.
- Section rhythm: every workflow section is a card with header row + body.
- Settings: essential (voice + language) visible; advanced collapsed by default.
- One primary action per section; secondary actions are ghost buttons.
- Consistent card surface + section gap.

**Acceptance:** one create-project entry point; settings advanced collapsed by default; no section runs into the next (clear card boundaries).

### Phase 5 — Camera wizard
**Files:** `BookSession.jsx`, `CameraCapture.jsx`, `VoiceSettings.jsx`, `reader.css`
- Real stepper (4 numbered steps, Signal current step).
- VoiceSettings collapsed to a pill in the header.
- Banners → single compact strip.
- Step transitions: content cross-fades, stepper advances with Signal fill.

**Acceptance:** stepper visible at all times; header height reduced; voice selector reachable in one click.

### Phase 6 — Motion, feedback & polish
**Files:** `Toast.jsx`, `shell.css`, `controls.css`, `Button.jsx`, all mode components
- Toast discipline: no navigation toasts, no per-toggle success toasts.
- Pressed states on all buttons (`:active` scale).
- Loading vocabulary: skeletons for page prep, Signal waveform for narration, progress bar for audio.
- Empty states: one shared pattern everywhere.
- Reduced-motion audit: all non-essential motion killed.

**Acceptance:** no toast fires on mode switch or toggle; every button has `:active`; loading states are contextual, not spinner-only; `prefers-reduced-motion` disables all non-essential animation.

---

## 8. Must-preserve invariants (non-negotiable)

These are the functional behaviors that the UX redesign must NOT touch:
- Resume-or-fresh dialog semantics.
- Word-level sync state machine (playing/paused/idle).
- Gapless chunked streaming incl. buffering-as-pause.
- Sleep timer modes incl. end-of-chapter + fire-on-ce.
- Media Session handlers + cleanup.
- Bookmarks/search/jump.
- RTL correctness (document-level dir/lang swap en↔ar).
- Device-scoped identity header/cookie.
- Capability gating (localFileActions/authRequired).
- Consent gates on every cloning path.
- Recorder review-before-commit.
- Immutable output history.
- Job reconnect/recovery UX.
- Legacy-project claim copy.
- Sidebar phone disclosure behavior.

---

## 9. Risks

- **PdfViewer.jsx is a 2,400-line monolith.** Phase 3 touches it heavily. Extract toolbar/transport state into hooks rather than growing the file.
- **styles-parity.test.js must evolve with tokens** in Phase 1 or it will block honestly.
- **Font loading:** adding Fraunces/Literata variable fonts adds FOUT risk → self-host, `font-display: swap`, subset latin+arabic only.
- **MSI bundle budget:** track after Phase 1 (fonts). Update `tasks/bundle-baseline.json` each phase.
- **Mode switch transition** must not trigger re-mount of the whole stage (loses scroll position, audio state). Use CSS transitions on already-mounted content, not key-based remount.

---

## 10. How we'll know it worked

- **Before/after screenshots** at 390px, 1024px, 1440px.
- **Heuristic evaluation** against the 6 principles (Section 2) — every screen passes.
- **Cognitive walkthrough:** a new user can answer "where am I, what can I do, what happens next" within 3 seconds on every screen.
- **No functional regression:** full test suite green.
- **Bundle budget:** entry bundle ≤ 260 KiB (current 248.6 + ~10 KiB for extended tokens).
