// F-30 — the blanket prefers-reduced-motion kill switch in base.css zeroes
// every animation, which silently deletes the entire contextual loading
// vocabulary: spinners freeze, waveform bars freeze at scaleY(0.3), and
// .loading-progress::after freezes at translateX(-100%) — invisible.
// Reduced-motion users got NO loading feedback at all.
//
// Guard: base.css keeps the blanket rule (right default), and every loading
// class it destroys gets an explicit static fallback inside a
// prefers-reduced-motion block.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const BASE_CSS = strip(readFileSync(join(HERE, 'base.css'), 'utf8'));
const CONTROLS_CSS = strip(readFileSync(join(HERE, 'controls.css'), 'utf8'));

function reducedMotionBlocks(source) {
    const out = [];
    const re = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
    for (const m of source.matchAll(re)) {
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < source.length && depth > 0) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') depth -= 1;
            i += 1;
        }
        out.push(source.slice(m.index, i));
    }
    return out.join('\n');
}

describe('reduced-motion loading fallbacks (F-30)', () => {
    const reduced = `${reducedMotionBlocks(BASE_CSS)}\n${reducedMotionBlocks(CONTROLS_CSS)}`;

    it('the blanket kill switch survives', () => {
        expect(BASE_CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
        expect(BASE_CSS).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    });

    it('no fallback survives for a swept class (F-11 consistency)', () => {
        // .loading-progress was deleted by the F-11 orphan sweep because the
        // bar is never rendered; a reduced-motion fallback for dead CSS would
        // be dead CSS too. If this fails while the class has no JSX user,
        // the sweep regressed.
        expect(CONTROLS_CSS + BASE_CSS).not.toMatch(/\.loading-progress/);
    });

    it('.loading-waveform bars render static full-height', () => {
        expect(reduced).toMatch(/\.loading-waveform[^{]*\{[^}]*animation:\s*none/);
        expect(reduced).toMatch(/\.loading-waveform[^{]*\{[^}]*transform:\s*scaleY\(1\)/);
    });

    it('.spinner stops animating (and ships next to a text label)', () => {
        expect(reduced).toMatch(/\.spinner[^{]*\{[^}]*animation:\s*none/);
    });
});
