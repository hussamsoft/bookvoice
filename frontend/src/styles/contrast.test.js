// F-22 — computed contrast assertions so token edits cannot regress AA.
//
// Parses the light/dark palette blocks out of tokens.css and computes the
// WCAG contrast ratio for every semantic text pair. Translucent backgrounds
// go through color-mix compositing (same formula as VERIFY.md §5), never an
// eyeballed hex.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = readFileSync(join(HERE, 'tokens.css'), 'utf8');

function lin(c) {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function lum(hex) {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a, b) {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function mix(fg, bg, pct) {
    const a = fg.replace('#', '');
    const b = bg.replace('#', '');
    return '#' + [0, 2, 4]
        .map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * pct
            + parseInt(b.slice(i, i + 2), 16) * (1 - pct)))
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');
}

// Pull the hex tokens out of each first-class Paper/Night block.
// Legacy palette ids intentionally share these semantic values.
function palettes() {
    const out = [];
    const re = /:root[^{]*data-palette="(\w+)"[^{]*data-mode="(\w+)"[^{]*\{([^}]*)\}/g;
    for (const m of TOKENS.matchAll(re)) {
        const vars = {};
        for (const vm of m[3].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
            vars[vm[1]] = vm[2];
        }
        out.push({ palette: m[1], mode: m[2], vars });
    }
    return out;
}

describe('WCAG AA contrast for semantic text pairs (F-22)', () => {
    const all = palettes();
    it('finds Paper and Night in both modes', () => {
        expect(all).toHaveLength(2);
        expect(new Set(all.map(({ mode }) => mode))).toEqual(new Set(['light', 'dark']));
    });

    for (const { palette, mode, vars } of all) {
        const label = `${palette}/${mode}`;
        const surface = vars.surface;

        it(`${label}: success text on surface ≥ 4.5`, () => {
            expect(ratio(vars.success, surface)).toBeGreaterThanOrEqual(4.5);
        });
        it(`${label}: error text on error-bg ≥ 4.5`, () => {
            const pct = mode === 'dark' ? 0.12 : 0.08;
            expect(ratio(vars.error, mix(vars.error, surface, pct))).toBeGreaterThanOrEqual(4.5);
        });
        it(`${label}: warning text on warning-bg ≥ 4.5`, () => {
            const pct = mode === 'dark' ? 0.12 : 0.10;
            expect(ratio(vars.warning, mix(vars.warning, surface, pct))).toBeGreaterThanOrEqual(4.5);
        });
        it(`${label}: accent-on text on live ≥ 4.5 (destructive primary button)`, () => {
            expect(ratio(vars['accent-on'], vars.live)).toBeGreaterThanOrEqual(4.5);
        });
        it(`${label}: ink-muted on surface ≥ 4.5`, () => {
            expect(ratio(vars['ink-muted'], surface)).toBeGreaterThanOrEqual(4.5);
        });
        it(`${label}: ink-secondary on surface ≥ 4.5`, () => {
            expect(ratio(vars['ink-secondary'], surface)).toBeGreaterThanOrEqual(4.5);
        });
    }
});
