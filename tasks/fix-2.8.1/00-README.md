# BookVoice 2.8.1 — remediation plan

> **Status — proposed.** Derived from the 2026-09-20 deep review of `4524079`
> (v2.8.0). Scope: the 44 findings in `FINDINGS.md`. Every phase is
> independently shippable and independently revertible.

## The one-paragraph diagnosis

2.8.0 deleted `PdfViewer.jsx` and replaced it with `reader/Reader.jsx`. The new
reader did not inherit the old one's design. Most severe findings trace to that
migration: components that still exist and still pass tests are wired to
nothing, CSS that still describes the better design is orphaned, and at least
one bug fix survives in the stylesheet with a selector that no longer matches
anything. **The Reader is the product, and it is currently the least finished
surface in the app.** The parts it needs — `PlaybackControls`, `Transcript`,
`useWordHighlight` — already exist and are already tested.

## Phase order and why

Ordering rule: **restore correctness before restoring capability, and delete
nothing until the thing that might revive it has landed.**

| Phase | Theme | Findings | Risk | Depends on |
|---|---|---|---|---|
| [1](01-phase-1-critical.md) | Critical correctness | F-01…F-06, F-14, F-15 (8) | Low — small, surgical diffs | — |
| [2](02-phase-2-reader-restoration.md) | Reader restoration | F-07, F-08, F-09, F-12, F-13, F-38 (6) | **High** — largest surface | Phase 1 |
| [3](03-phase-3-responsive-touch.md) | Responsive & touch | F-10, F-16…F-21, F-41 (8) | Medium | Phase 2 (transport lands) |
| [4](04-phase-4-accessibility.md) | Accessibility | F-22…F-31, F-42 (11) | Low | Phases 2, 3 |
| [5](05-phase-5-state-theme.md) | State & theme | F-32…F-36, F-39, F-40 (7) | Medium | Phase 1 |
| [6](06-phase-6-cleanup.md) | Cleanup & guardrails | F-11, F-37, F-43, F-44 (4) | Low | **All of the above** |

All 44 findings are assigned; none is orphaned between phases.

**Phase 6 must run last.** The dead-CSS sweep in F-11 deletes 89 orphaned
classes — but Phase 2 legitimately *revives* some of them (`.bookmark-jump`,
`.reader-nav-more`, `.playback-controls`, `.transcript-*`,
`.pdf-load-error-*`). Sweeping before Phase 2 deletes CSS Phase 2 needs.
Re-run the sweep at the start of Phase 6, do not trust the list captured in the
review.

## Global rules for every phase

1. **One phase per branch, one logical change per commit.** Conventional
   commit messages (the repo convention).
2. **Never widen scope inside a phase.** A finding not listed in the phase file
   goes to `FINDINGS.md` as deferred, not into the diff.
3. **Every behavioural fix gets a regression test that fails before the fix.**
   The 2.8.0 suite is 386 green tests that caught none of these 44 findings.
   A fix with no failing-first test is not done.
4. **Any change under `frontend/` requires a rebuild and a committed
   `backend/static`** — `scripts/check_static_sync.py` is a gating CI check and
   a stale bundle has shipped twice before (2.6.0, 2.6.1).
5. **Do not refactor adjacent code.** Minimal targeted diffs.

## Verification

Full protocol in [`VERIFY.md`](VERIFY.md). The short version — all five must
pass before any phase is signed off:

```bash
python -m pytest tests -q                       # from repo root
cd frontend && npm run lint                     # oxlint, no-undef is enabled
cd frontend && npm run test                     # vitest
cd frontend && npm run build
python scripts/check_static_sync.py             # from repo root, after build
```

## Files

- [`FINDINGS.md`](FINDINGS.md) — all 44 findings, stable IDs, phase assignment, status
- [`VERIFY.md`](VERIFY.md) — verification protocol and per-phase exit gates
- [`AGENT-PROMPT.md`](AGENT-PROMPT.md) — the autonomous-agent goal prompt
