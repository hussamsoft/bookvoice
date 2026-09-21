# Agent goal prompt

Paste the block below as the agent's task. It is deliberately short — the plan
files carry the detail, and the agent is told to read them.

---

```
Work through tasks/fix-2.8.1/ until every finding is fixed and verified.

Read tasks/fix-2.8.1/00-README.md first, then FINDINGS.md and VERIFY.md.
Work phases 1 -> 6 in order. Within a phase, work findings in order.

Loop, one finding at a time:
  1. Read the finding in its phase file.
  2. Write a regression test and RUN IT. It must FAIL. Paste the failure into
     the phase log. If a finding genuinely cannot be tested automatically,
     write that in the log with manual repro steps instead - do not skip silently.
  3. Make the smallest fix that addresses the finding. Do not refactor
     anything adjacent. Do not fix findings from a later phase.
  4. Run the test. It must pass.
  5. Run the full gate:
       python -m pytest tests -q
       cd frontend && npm run lint && npm run test && npm run build
       python scripts/check_static_sync.py
     All five must pass. Rebuild and commit backend/static for any frontend change.
  6. Set the finding to `verified` in FINDINGS.md. Commit (conventional message).
  7. Append to tasks/fix-2.8.1/LOG.md: finding id, what changed, test name,
     failure output before, anything deferred and why.

At the end of each phase, do the phase's extra verification from VERIFY.md §3
and its Exit gate checklist before starting the next phase. Do not start
Phase 6 before Phases 1-5 are complete - it deletes CSS that Phase 2 revives.

Rules:
- Never mark a finding verified on the strength of reading the code. The 44
  findings in this plan exist in a codebase with 386 passing tests.
- If a fix needs a product decision (F-08 wire-vs-delete is the main one),
  stop and ask. Do not guess.
- If a finding turns out to be wrong or already fixed, say so, write the
  evidence in LOG.md, mark it `invalid`, and move on. Do not invent work.
- Never weaken or delete a test to make the gate pass.

Sign-off: report done only when every row in FINDINGS.md is `verified` or
`invalid` or has a written deferral reason, the full gate passes from a clean
tree, and scripts/audit_a11y.py reports zero unjustified violations. State
plainly what you did not finish.
```

---

## Running it as a loop

In Claude Code, `/loop` with no interval lets the agent pace itself:

```
/loop Continue tasks/fix-2.8.1/. Read LOG.md for where you left off, then keep
going per AGENT-PROMPT.md. Stop when FINDINGS.md has no `open` rows left.
```

## Notes on scope control

The two places an agent will most likely overreach:

- **F-08** (orphaned `useWordHighlight` stack) is a genuine product decision —
  wire it in or delete it. The prompt tells the agent to stop and ask. Answer it
  yourself; the recommendation is to wire it, but either is far better than the
  status quo.
- **F-13** (toolbar regrouping) and **F-43** (`logging` migration) are the two
  largest diffs. If the agent starts sprawling, split each into its own branch.

## What this plan does not cover

Deliberately out of scope, tracked in `FINDINGS.md`:

- Book cover thumbnails — a feature, not a fix
- Anything in `chatterbox/`, `tools/` (vendored WiX), or the installer chain
- The backend `logging` migration is listed but flagged to land as its own PR
