// F-18 — backdrop-filter only where content actually passes behind.
//
// `.main-header` and `.sidebar` are flex:none siblings of the scrolling
// content — nothing ever passes under them, so their blur only sampled the
// static shell gradient at the cost of two permanent compositor layers.
// `.modal-panel` blurred an already-blurred `.modal-overlay` backdrop
// through 88%-opaque glass: two full-screen passes for no visible delta.
//
// F-20 — the toast region must clear the mobile bottom nav.
//
// Pre-fix `.toast-region` sat at `bottom: var(--space-5)` (24px) with no
// safe-area offset; at ≤720px the sidebar becomes a fixed bottom bar, so
// toasts rendered on top of Scan / Studio / Settings. Also
// `.toast-region-error` was orphaned (Toast.jsx renders one region).
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
        expect(combined).toMatch(/\.toast-region\b/);
        // The offset must derive from a token (nav height + safe area),
        // not a hardcoded pixel value.
        const toastRule = combined.match(/\.toast-region\s*\{([^}]*)\}/);
        expect(toastRule).toBeTruthy();
        expect(toastRule[1]).toMatch(/bottom:\s*calc\(/);
        expect(toastRule[1]).toMatch(/--bottom-nav-h/);
    });

    it('the orphaned .toast-region-error selector is gone', () => {
        expect(SHELL_CSS).not.toMatch(/\.toast-region-error/);
    });
});
