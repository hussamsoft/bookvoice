// F-17 — the Button `size` prop must actually change the button's size.
//
// Pre-fix `.btn-sm` / `.btn-lg` lived ONLY in base.css (imported before
// controls.css). `.btn` in controls.css (same 0,1,0 specificity, later
// file) overrode their padding and font-size, and its `min-height: 36px`
// beat `.btn-sm`'s `height: 28px` — so `size="sm"` was fully inert.
// Fix: define the sizes as `.btn.btn-sm` / `.btn.btn-lg` compounds in
// controls.css after `.btn`, using min-height consistently.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_CSS = readFileSync(join(HERE, 'base.css'), 'utf8');
const CONTROLS_CSS = readFileSync(join(HERE, 'controls.css'), 'utf8');

describe('Button size prop (F-17)', () => {
    it('base.css no longer carries the inert bare size rules', () => {
        expect(BASE_CSS).not.toMatch(/^\.btn-sm\s*\{/m);
        expect(BASE_CSS).not.toMatch(/^\.btn-lg\s*\{/m);
    });

    it('controls.css defines .btn.btn-sm and .btn.btn-lg compounds after .btn', () => {
        const btnIdx = CONTROLS_CSS.search(/^\.btn\s*\{/m);
        expect(btnIdx, '.btn base rule not found in controls.css').toBeGreaterThan(-1);
        const smIdx = CONTROLS_CSS.indexOf('.btn.btn-sm');
        const lgIdx = CONTROLS_CSS.indexOf('.btn.btn-lg');
        expect(smIdx, '.btn.btn-sm missing from controls.css').toBeGreaterThan(btnIdx);
        expect(lgIdx, '.btn.btn-lg missing from controls.css').toBeGreaterThan(btnIdx);
    });

    it('size rules use min-height so coarse-pointer overrides can still win', () => {
        const sm = CONTROLS_CSS.match(/\.btn\.btn-sm[^{]*\{([^}]*)\}/);
        expect(sm).toBeTruthy();
        expect(sm[1]).toMatch(/min-height\s*:\s*var\(--control-h-sm\)/);
        expect(sm[1]).not.toMatch(/^\s*height\s*:/m);
    });
});
