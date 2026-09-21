// F-42 — the mobile sidebar used a 3-value padding shorthand whose single
// horizontal value was `env(safe-area-inset-left)`, applied to BOTH sides.
// On a landscape notched phone the left and right insets differ (notch on
// one side, camera/home indicator on the other) — one side got the wrong
// clearance. Guard: the sidebar must consume each inset explicitly.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const SHELL_CSS = strip(readFileSync(join(HERE, 'shell.css'), 'utf8'));

describe('mobile sidebar safe areas (F-42)', () => {
    it('uses BOTH safe-area insets, not left for both sides', () => {
        expect(SHELL_CSS).toMatch(/env\(safe-area-inset-left\)/);
        expect(SHELL_CSS).toMatch(/env\(safe-area-inset-right\)/);
    });

    it('the sidebar rule separates inline sides (logical or explicit)', () => {
        // Either padding-inline (2-value) or explicit left/right properties.
        const re = /\.sidebar\s*\{([^}]*)\}/g;
        const blocks = Array.from(SHELL_CSS.matchAll(re), (m) => m[1]);
        expect(blocks.length).toBeGreaterThan(0);
        const withInsets = blocks.filter((b) => /safe-area-inset-(left|right)/.test(b));
        expect(withInsets.length).toBeGreaterThan(0);
        for (const body of withInsets) {
            const usesInline = /padding-inline:\s*[^;]*inset-left[^;]*inset-right/.test(body)
                || /padding-inline-start:[^;]*inset-left[^;]*padding-inline-end:[^;]*inset-right/.test(body);
            const usesSides = /padding-left:[^;]*inset-left/.test(body)
                && /padding-right:[^;]*inset-right/.test(body);
            expect(usesInline || usesSides).toBe(true);
        }
    });
});
