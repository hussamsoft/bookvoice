// F-44 — .transport-scrubber thumb centering used a hardcoded `margin-top:
// -7px` while the thumb size itself was `calc(var(--control-h-sm) * 0.5)`:
// change --control-h-sm and the thumb leaves the track. Both now derive from
// the same local geometry vars; guard that they stay derived.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const CONTROLS_CSS = strip(readFileSync(join(HERE, 'controls.css'), 'utf8'));

describe('scrubber geometry derives from tokens (F-44)', () => {
    it('no hardcoded thumb offset remains', () => {
        expect(CONTROLS_CSS).not.toMatch(/margin-top:\s*-7px/);
    });

    it('the offset is computed from the track/thumb vars', () => {
        const base = CONTROLS_CSS.match(/\.transport-scrubber\s*\{([^}]*)\}/);
        expect(base).toBeTruthy();
        expect(base[1]).toMatch(/--scrub-track-h:/);
        expect(base[1]).toMatch(/--scrub-thumb-size:\s*calc\(var\(--control-h-sm\)/);
        const thumb = CONTROLS_CSS.match(/\.transport-scrubber::-webkit-slider-thumb\s*\{([^}]*)\}/);
        expect(thumb[1]).toMatch(/margin-top:\s*calc\(\(var\(--scrub-track-h\)\s*-\s*var\(--scrub-thumb-size\)\)\s*\/\s*2\)/);
        expect(thumb[1]).toMatch(/width:\s*var\(--scrub-thumb-size\)/);
    });
});
