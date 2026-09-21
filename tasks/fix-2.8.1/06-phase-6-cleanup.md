# Phase 6 — Cleanup and guardrails

**Findings:** F-11, F-37, F-43, F-44 · **Risk:** low · **Depends on:** **all
previous phases**

> **Do not start this phase early.** The dead-CSS sweep deletes 89 orphaned
> classes, but Phase 2 legitimately *revives* several of them
> (`.bookmark-jump`, `.reader-nav-more`, `.reader-nav-menu*`,
> `.playback-controls`, `.transcript-*`, `.pdf-load-error-*`). Sweeping first
> deletes CSS that Phase 2 needs. **Re-run the sweep to generate a fresh list —
> do not trust the list captured in the review.**

---

## F-11 — 89 of 421 CSS classes orphaned, and the guard only looks one way

The review swept mechanically and hand-verified template-literal false
positives (`toast-${type}` and friends are live). The orphans concentrate in the
deleted PdfViewer's surfaces:

- `reader.css` — `.pdf-toolbar`, `.pdf-layout`, `.pdf-main`, `.pdf-transcript*`,
  `.pdf-upload-*`, `.pdf-load-error-*`, `.reader-nav-*`, `.reading-options-*`,
  `.playback-controls`, `.bookmark-jump`, `.reader-follow`, `.step-indicator`,
  `.zoomable`, `.page-search`, `.file-upload`
- `shell.css` — the whole `.theme-selector-*` dropdown, `.settings-dropdown`,
  `.settings-panel-wrap`, `.mode-indicator`, `.reading-stage` (~150 lines)
- `studio.css` — `.studio-empty`, `.studio-advanced`, `.studio-workflow-panels`,
  `.w3`, `.studio-seed`, `.studio-guidance`, +4
- `base.css` — `.skeleton--line`
- `controls.css` — `.control-btn`, `.creation-controls`, `.field-label`,
  `.loading-progress`, `.btn-large`, `.voice-creation`
- Dead tokens — `--transport-height` (`tokens.css:448`);
  `--radius-full` duplicates `--radius-pill`

**Root cause:** `styles-parity.test.js` guards only one direction — *"every JSX
className resolves to a CSS selector."* Its own docstring says it exists because
*"the 2026-08 design-system swap silently orphaned ~17 class names"*. The swap
that followed orphaned 89, in the other direction, unseen.

**Tasks**

- [ ] Regenerate the orphan list against the post-Phase-5 tree. Sweep script:
      collect `\.([A-Za-z][\w-]*)` from `src/styles/*.css`, check each against
      the full text of all non-test `.js`/`.jsx` plus `index.html`, and
      hand-check anything constructed by template literal.
- [ ] Delete the confirmed orphans.
- [ ] **Add the inverse assertion to `styles-parity.test.js`**: every CSS class
      must appear in source, with an explicit allowlist for third-party
      (`react-pdf__*`) and dynamically-composed names. This is the guardrail that
      makes the whole class of bug non-recurring — it is worth more than the
      deletion.
- [ ] Remove `'compact'` from the existing `ALLOWLIST` once Phase 3 F-16 has
      collapsed the alias. That entry is what masked the touch-target gap.
- [ ] De-duplicate rules defined in two stylesheets:
      `.transport-play.is-playing` (`controls.css:545` + `reader.css:396`),
      `.transport-primary` / `.transport-secondary` / `.playback-transport`
      (both files; `.transport-secondary` twice within `reader.css`).
- [ ] Delete the no-op `@media (max-width: 480px) .shortcuts-grid` rule — the
      base rule is already `1fr`.

**Acceptance** — zero orphaned classes; the inverse test fails if one is
introduced.

---

## F-37 — Vestigial code and stale comments

`Reader.jsx:94-95` — `userTouchedVoiceRef` / `userTouchedLanguageRef` are
**never set to `true`** (there is no voice or language UI in the Reader), so the
"user touch wins over config" logic guards a case that cannot occur. Its comment
cites `configApply.test.js`, which actually covers `BookSession`.

*If Phase 2 added the voice/language picker, these become real — verify rather
than delete.*

**Stale comments to correct or remove:**

- [ ] `reader.css:136-138` — "The real `<Document>`+`<Page>` lives in the
      production PdfViewer until the TTS pipeline is ported." PdfViewer is gone
      and `PdfStage` renders react-pdf.
- [ ] `PlaybackControls.jsx:52` — "see PdfViewer wiring".
- [ ] `shell.css:464` — "Targets stay >= 44px (pointer: coarse rules apply)".
      There are no `pointer: coarse` rules in `shell.css`. Either add them
      (Phase 3) or fix the claim.
- [ ] `useUserConfig.js:16-19` — contradicts the `??=` on line 37.
- [ ] `Reader.jsx:305-306` — visibility flush (fixed in Phase 5 F-36; confirm the
      comment now matches).
- [ ] `controls.css:654-657` — "Secondary actions stay reachable via media keys
      / the transport's other hosts" justifying hiding skip and rate on mobile.
      On a phone there are no other hosts. Resolved by Phase 3; delete the
      rationalisation.
- [ ] Grep for remaining `PdfViewer` references across `frontend/src` and
      `tasks/` and clear them.

---

## F-43 — Backend hygiene

The backend is genuinely well-hardened — origin allowlist, session gating
(including `/sessions/*` audio, `access_service.py:252-253`), `safe_join`
traversal guards, nosniff/frame-options/referrer-policy, content-addressed book
ids. These are the remaining rough edges.

**Tasks**

- [ ] **`print()` instead of `logging`** (~50 sites). In a PyInstaller windowed
      build stdout is detached: no log file, no levels, no way to diagnose a user
      report. This is the biggest backend gap. Land as its own PR — a single
      `logging` config in `main.py` plus a mechanical call-site replacement, with
      a rotating file handler under `%LocalAppData%\BookVoice\logs`.
- [ ] `main.py:166` — `STATIC_DIR = Path("static").resolve()` is CWD-relative.
      Launched from elsewhere it silently degrades to the "Frontend not built"
      JSON root, despite `APP_DIR` being read on line 59. Resolve against
      `APP_DIR`.
- [ ] `main.py:34-37` — `voices.seed_default_voices()` runs at **import time**
      with errors swallowed to a `print`, unlike all other startup work which
      lives in `lifespan`. Move it into `lifespan`.
- [ ] `main.py:139` — add a comment noting `style-src 'unsafe-inline'` is
      deliberate and unavoidable (React inline styles, react-pdf), so a future
      reader does not "fix" it.

---

## F-44 — Miscellaneous

- [ ] `PdfStage.jsx:59-69` — the `ResizeObserver` calls `setPageWidth` on every
      resize frame, re-rendering the whole PDF page undebounced. Dragging a
      window edge re-renders continuously. Debounce (`useReaderZoom` already has
      the `displayZoom` pattern to copy).
- [ ] `controls.css` — `.transport-scrubber` hardcodes `margin-top: -7px` to
      centre a thumb sized by `calc(var(--control-h-sm) * 0.5)`. Derive the
      offset from the token so they cannot drift.
- [ ] Add `type="button"` to the `history-item` buttons (`BookSession.jsx:324`)
      and the toast dismiss (`Toast.jsx:123`). Safe today, inconsistent with the
      rest of the codebase.
- [ ] `PreparedBookRow.jsx:164` — `{details.pageCount || '—'}` renders
      "12/— narrated". Handle the unknown case in words.
- [ ] `BookSession.jsx:173` — every scan session on the same day produces an
      identically titled book ("Scanned pages 2026-09-20"). Add a time or a
      counter.
- [ ] `--radius-full` / `--radius-pill` duplication — keep one.

---

## Exit gate

- [ ] Orphan sweep regenerated post-Phase-5 and returns zero.
- [ ] Inverse parity assertion added to `styles-parity.test.js` and green.
- [ ] `'compact'` removed from the parity allowlist.
- [ ] No `PdfViewer` references remain in `frontend/src`.
- [ ] Bundle budget still met: `python scripts/measure_bundle.py` under 350 KiB.
- [ ] Full verification suite green; `backend/static` rebuilt and committed.
- [ ] `FINDINGS.md` — every row is `verified` or has a written deferral reason.
