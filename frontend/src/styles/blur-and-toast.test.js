// F-18 — backdrop-filter only where content actually passes behind.
//
// `.main-header` and `.sidebar` are flex:none siblings of the scrolling
// content — nothing ever passes under them, so their blur only sampled the
// static shell gradient at the cost of two permanent compositor layers.
// `.modal-panel` blurred an already-blurred `.modal-overlay` backdrop
// through 88%-opaque glass: two full-screen passes for no visible delta.
//
// F-20 — the toast stack must clear the mobile bottom nav.
//
// Pre-fix `.toast-region` sat at `bottom: var(--space-5)` (24px) with no
// safe-area offset; at ≤720px the sidebar becomes a fixed bottom bar, so
// toasts rendered on top of Scan / Studio / Settings. At the time
// `.toast-region-error` was orphaned (Toast.jsx rendered one region).
//
// F-26 supersedes that premise: the toast system now renders TWO persistent
// live regions (polite + assertive-for-errors). The fixed positioning moved
// to a shared `.toast-stack` wrapper so the regions can never overlap; the
// clearance contract (calc-based offset from --bottom-nav-h) is unchanged,
// and `.toast-region-error` is rendered again — deliberately, with styling.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// Strip CSS comments so explanatory notes mentioning e.g. "backdrop-filter"
// don't satisfy (or fail) the assertions.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const SHELL_CSS = strip(readFileSync(join(HERE, 'shell.css'), 'utf8'));
const CONTROLS_CSS = strip(readFileSync(join(HERE, 'controls.css'), 'utf8'));

function ruleBlocks(source, selector) {
    // Every top-level occurrence of `selector {` (selector may be part of
    // a selector list — we only need the block that starts with it).
    const out = [];
    const re = new RegExp(`(?:^|[}\\n])\\s*${selector}\\s*\\{`, 'gm');
    for (const m of source.matchAll(re)) {
        const open = source.indexOf('{', m.index);
        let depth = 1;
        let i = open + 1;
        while (i < source.length && depth > 0) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') depth -= 1;
            i += 1;
        }
        out.push(source.slice(open + 1, i - 1));
    }
    return out;
}

describe('backdrop-filter placement (F-18)', () => {
    it('.main-header does not blur', () => {
        const blocks = ruleBlocks(SHELL_CSS, '\\.main-header');
        expect(blocks.length, '.main-header rule not found').toBeGreaterThan(0);
        for (const body of blocks) {
            expect(body).not.toMatch(/backdrop-filter/);
        }
    });

    it('.sidebar does not blur', () => {
        const blocks = ruleBlocks(SHELL_CSS, '\\.sidebar');
        expect(blocks.length).toBeGreaterThan(0);
        for (const body of blocks) {
            expect(body).not.toMatch(/backdrop-filter/);
        }
    });

    it('.modal-panel does not double-blur over the overlay', () => {
        const blocks = ruleBlocks(CONTROLS_CSS, '\\.modal-panel');
        expect(blocks.length).toBeGreaterThan(0);
        for (const body of blocks) {
            expect(body).not.toMatch(/backdrop-filter/);
        }
        // The overlay keeps its blur — content genuinely scrolls behind it.
        const overlay = ruleBlocks(CONTROLS_CSS, '\\.modal-overlay');
        expect(overlay.some((b) => /backdrop-filter/.test(b))).toBe(true);
    });
});

describe('toast region clears the mobile nav (F-20)', () => {
    it('at ≤720px the toast region offsets above the bottom nav', () => {
        const start = SHELL_CSS.indexOf('@media (max-width: 720px)');
        expect(start).toBeGreaterThan(-1);
        // Grab every ≤720px block (there may be several).
        const blocks = [];
        let from = 0;
        for (;;) {
            const idx = SHELL_CSS.indexOf('@media (max-width: 720px)', from);
            if (idx < 0) break;
            const open = SHELL_CSS.indexOf('{', idx);
            let depth = 1;
            let i = open + 1;
            while (i < SHELL_CSS.length && depth > 0) {
                if (SHELL_CSS[i] === '{') depth += 1;
                else if (SHELL_CSS[i] === '}') depth -= 1;
                i += 1;
            }
            blocks.push(SHELL_CSS.slice(open + 1, i - 1));
            from = i;
        }
        const combined = blocks.join('\n');
        // F-26: the fixed container is the `.toast-stack` wrapper around the
        // two live regions; the clearance contract itself is F-20's.
        expect(combined).toMatch(/\.toast-stack\b/);
        const stackRule = combined.match(/\.toast-stack\s*\{([^}]*)\}/);
        expect(stackRule).toBeTruthy();
        expect(stackRule[1]).toMatch(/bottom:\s*calc\(/);
        expect(stackRule[1]).toMatch(/--bottom-nav-h/);
    });

    it('both live regions are styled and share the stack (F-26)', () => {
        // .toast-region-error was orphaned (F-20); F-26 renders it again as
        // the persistent assertive region, so it must have real styling —
        // and neither region may carry its own `position: fixed`, or the
        // two regions overlap each other.
        expect(SHELL_CSS).toMatch(/\.toast-region[,\s][^{]*\{[^}]*\}/);
        expect(SHELL_CSS).toMatch(/\.toast-region-error/);
        for (const sel of ['\\.toast-region', '\\.toast-region-error']) {
            for (const body of ruleBlocks(SHELL_CSS, sel)) {
                expect(body).not.toMatch(/position:\s*fixed/);
            }
        }
        const stack = ruleBlocks(SHELL_CSS, '\\.toast-stack');
        expect(stack.some((b) => /position:\s*fixed/.test(b))).toBe(true);
    });
});
