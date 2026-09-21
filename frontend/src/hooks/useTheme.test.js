// F-14 — palette swatches must render distinctly and not mutate the DOM
// during render.
//
// Pre-fix `getSwatchColor` appended a probe <div data-palette=…> and read
// `--accent` from it. Every palette rule in tokens.css is scoped to
// `:root[data-palette=…]`, so the probe never matched and all ten swatches
// resolved to the *currently active* accent. The fix routes the swatch
// through a static palette×mode map.
import { describe, it, expect, vi } from 'vitest';
import { PALETTES, getSwatchColor } from './useTheme';

describe('palette swatches (F-14)', () => {
    it('every palette id has accents for both light and dark modes', () => {
        for (const p of PALETTES) {
            expect(p.accents, `${p.id}.accents missing`).toBeTypeOf('object');
            expect(p.accents.light, `${p.id} light accent missing`).toMatch(/^#[0-9a-f]{6}$/i);
            expect(p.accents.dark, `${p.id} dark accent missing`).toMatch(/^#[0-9a-f]{6}$/i);
        }
    });

    it('all ten swatches are visually distinct', () => {
        const seen = new Set();
        for (const p of PALETTES) {
            for (const mode of ['light', 'dark']) {
                const key = `${p.id}:${mode}`;
                expect(seen.has(key), `duplicate swatch entry: ${key}`).toBe(false);
                seen.add(key);
            }
        }
        const colors = new Set();
        for (const p of PALETTES) {
            for (const mode of ['light', 'dark']) {
                colors.add(p.accents[mode].toLowerCase());
            }
        }
        expect(colors.size).toBe(10);
    });

    it('getSwatchColor returns the static map entry, with no DOM access', () => {
        // If the implementation were still calling createElement('div') and
        // getComputedStyle on it, jsdom's body would grow without bound; this
        // test would either leak through or fail because the DOM was touched
        // outside the test's control.
        const appendSpy = vi.spyOn(document.body, 'appendChild');
        try {
            for (const p of PALETTES) {
                for (const mode of ['light', 'dark']) {
                    expect(getSwatchColor(p.id, mode)).toBe(p.accents[mode]);
                }
            }
            expect(appendSpy).not.toHaveBeenCalled();
        } finally {
            appendSpy.mockRestore();
        }
    });

    it('getSwatchColor falls back to a valid hex for unknown palettes', () => {
        const fallback = getSwatchColor('does-not-exist', 'light');
        expect(fallback).toMatch(/^#[0-9a-f]{6}$/i);
    });
});
