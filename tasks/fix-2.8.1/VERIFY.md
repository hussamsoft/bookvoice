# Verification protocol

The 2.8.0 suite is **386 green tests across 65 files that caught none of the 44
findings**. Passing tests is therefore necessary but nowhere near sufficient.
Every phase needs its own evidence.

---

## 1. The gate (must pass before any phase is signed off)

Matches `.github/workflows/ci.yml`. Run from the repo root unless noted.

```bash
python -m pytest tests -q
cd frontend && npm run lint          # oxlint; no-undef is enabled deliberately
cd frontend && npm run test          # vitest
cd frontend && npm run build
python scripts/check_static_sync.py  # repo root, AFTER the build
python scripts/measure_bundle.py     # initial entry must stay under 350 KiB
```

**`check_static_sync.py` is the one people forget.** Any change under
`frontend/` requires rebuilding and committing `backend/static/`. A stale
committed bundle shipped unnoticed in 2.6.0 and 2.6.1 — that check exists
because of it.

---

## 2. Failing-first discipline

A fix without a test that failed before it is **not done**.

For each finding:

1. Write the test. Run it. **Watch it fail**, and record the failure output in
   the phase log.
2. Apply the fix.
3. Run it. Watch it pass.
4. Run the full gate.

If a finding genuinely cannot be covered by an automated test (pure layout,
pure visual), say so explicitly in the phase log and record the manual
reproduction steps instead. Do not skip silently.

---

## 3. Per-phase extras

| Phase | Additional verification |
|---|---|
| 1 | Production build served by the backend, console open: **zero CSP violations**. Launch in dark mode: no light flash. |
| 2 | Manual: open a PDF book and a text book, narrate a page, scrub, change rate, jump to a bookmark, search, turn pages. No console errors. |
| 3 | Responsive pass at 1280 / 1024 / 820 / 768 / 390 px in light and dark across Reader, Library, Home, Settings, Scan. |
| 4 | `python scripts/audit_a11y.py` — zero axe violations, or each remaining one justified in `FINDINGS.md`. Keyboard-only traversal. Reduced-motion pass. |
| 5 | Toggle the OS theme with the app open in `system` mode. Corrupt `localStorage['bookvoice.palette']`, reload, confirm self-heal. |
| 6 | Orphan sweep returns zero; inverse parity assertion green. |

---

## 4. The dead-CSS sweep

Run this at the **start of Phase 6**, not before — Phase 2 revives classes the
review counted as dead.

```bash
python - <<'PY'
import re, pathlib
root = pathlib.Path('frontend/src')
defined = {}
for f in sorted((root/'styles').glob('*.css')):
    txt = re.sub(r'/\*.*?\*/', '', f.read_text(encoding='utf8'), flags=re.S)
    for m in re.finditer(r'\.([A-Za-z][A-Za-z0-9_-]*)', txt):
        defined.setdefault(m.group(1), set()).add(f.name)
blob = '\n'.join(
    f.read_text(encoding='utf8')
    for f in root.rglob('*')
    if f.suffix in ('.jsx', '.js') and '.test.' not in f.name
) + pathlib.Path('frontend/index.html').read_text(encoding='utf8')
dead = [(n, ','.join(sorted(v))) for n, v in sorted(defined.items()) if n not in blob]
print(f"{len(defined)} defined, {len(dead)} never referenced in source:\n")
for n, f in dead:
    print(f"  .{n:40s} [{f}]")
PY
```

**Hand-check every hit before deleting.** Classes composed by template literal
(`toast-${type}` → `.toast-info` / `.toast-success` / `.toast-error`;
`skeleton--${kind}`) are false positives. The point of the exercise is the
inverse assertion you add to `styles-parity.test.js` afterwards, not the
deletion.

---

## 5. Contrast check

Used to produce the F-22 table; re-run after any token edit.

```bash
python - <<'PY'
def lin(c):
    c /= 255
    return c/12.92 if c <= 0.03928 else ((c+0.055)/1.055)**2.4
def L(h):
    h = h.lstrip('#')
    r, g, b = (int(h[i:i+2], 16) for i in (0, 2, 4))
    return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)
def ratio(a, b):
    la, lb = L(a), L(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)
def mix(fg, bg, pct):
    """color-mix(in srgb, fg pct%, transparent) composited over bg."""
    a, b = fg.lstrip('#'), bg.lstrip('#')
    return '#' + ''.join(
        '%02x' % round(int(a[i:i+2], 16)*pct + int(b[i:i+2], 16)*(1-pct))
        for i in (0, 2, 4)
    )

SURFACE = "#ffffff"   # light-mode --surface
# fg, bg, label  — extend with any pair you touch.
# Translucent backgrounds MUST go through mix(), not an eyeballed hex.
pairs = [
    ("#0f8f66", SURFACE,                        "success on surface (light)"),
    ("#cc3f57", mix("#cc3f57", SURFACE, 0.08),  "error text on error-bg (light)"),
    ("#a06c00", mix("#a06c00", SURFACE, 0.10),  "warning text on warning-bg (light)"),
    ("#ffffff", "#d64560",                      "accent-on on live (light)"),
    ("#8f8ca6", SURFACE,                        "ink-faint on surface (light)"),
]
for fg, bg, label in pairs:
    r = ratio(fg, bg)
    print(f"{label:40s} {r:5.2f}  {'PASS' if r >= 4.5 else 'FAIL'}")
PY
```

Promote this into a real vitest assertion in Phase 4 so token edits cannot
regress contrast.

---

## 6. What "signed off" means

A phase is complete when **all** of these hold:

- [ ] Every finding in the phase file is `verified` in `FINDINGS.md`
- [ ] Every fix has a test that was demonstrated failing first, or a written
      reason it cannot be tested plus manual repro steps
- [ ] The full gate (§1) passes from a clean tree
- [ ] `backend/static` is rebuilt and committed
- [ ] The phase's extra verification (§3) is done and recorded
- [ ] The phase log records what was done, what was deferred, and why

**Never mark a finding `verified` on the strength of reading the code.** The 44
findings in this plan exist in a codebase with 386 passing tests written by
people reading the same code.
