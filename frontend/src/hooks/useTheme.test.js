// F-14 — palette swatches must render distinctly and not mutate the DOM
// during render.
//
// Pre-fix `getSwatchColor` appended a probe <div data-palette=…> and read
// `--accent` from it. Every palette rule in tokens.css is scoped to
// `:root[data-palette=…]`, so the probe never matched and all ten swatches
// resolved to the *currently active* accent. The fix routes the swatch
// through a static palette×mode map.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { PALETTES, getSwatchColor, useTheme } from './useTheme';

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

// F-35 — follow-system, live OS updates, and self-healing validation.
describe('theme: system mode and validation (F-35)', () => {
    let listeners;
    let mqState;

    beforeEach(() => {
        localStorage.clear();
        listeners = [];
        mqState = { matches: false };
        // jsdom in this project ships no matchMedia at all (the guarded
        // `typeof window.matchMedia === 'function'` paths in useTheme exist
        // for exactly that reason) — define the global for these tests.
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            writable: true,
            value: vi.fn((query) => ({
                matches: query.includes('prefers-color-scheme: dark') ? mqState.matches : false,
                media: query,
                addEventListener: (_event, handler) => listeners.push(handler),
                removeEventListener: (_event, handler) => {
                    listeners = listeners.filter((l) => l !== handler);
                },
            })),
        });
    });

    afterEach(() => {
        delete window.matchMedia;
        localStorage.clear();
    });

    const setSystemDark = (value) => {
        mqState.matches = value;
        act(() => {
            for (const listener of listeners) listener({ matches: value });
        });
    };

    it('a fresh install follows the OS and does not persist a chosen mode', () => {
        const { result } = renderHook(() => useTheme());
        expect(result.current.mode).toBe('system');
        expect(result.current.effectiveMode).toBe('light');
        expect(document.documentElement.dataset.mode).toBe('light');
        // Nothing was chosen yet — storage stays empty so the OS keeps
        // owning the value.
        expect(localStorage.getItem('bookvoice.mode')).toBeNull();
    });

    it('system mode tracks OS changes while no explicit choice exists', () => {
        const { result } = renderHook(() => useTheme());
        setSystemDark(true);
        expect(result.current.effectiveMode).toBe('dark');
        expect(document.documentElement.dataset.mode).toBe('dark');
    });

    it('an explicit choice survives OS changes and persists', () => {
        const { result } = renderHook(() => useTheme());
        act(() => result.current.setMode('dark'));
        expect(localStorage.getItem('bookvoice.mode')).toBe('dark');
        setSystemDark(false);
        expect(result.current.effectiveMode).toBe('dark');
    });

    it('toggleMode converts system into the opposite explicit choice', () => {
        const { result } = renderHook(() => useTheme());
        act(() => result.current.toggleMode()); // effective light -> dark
        expect(result.current.mode).toBe('dark');
        expect(result.current.effectiveMode).toBe('dark');
    });

    it('a corrupt stored palette self-heals to the default and rewrites storage', () => {
        localStorage.setItem('bookvoice.palette', 'not-a-palette');
        localStorage.setItem('bookvoice.mode', 'chartreuse');
        const { result } = renderHook(() => useTheme());
        expect(result.current.palette).toBe('paper');
        expect(result.current.mode).toBe('system');
        expect(localStorage.getItem('bookvoice.palette')).toBe('paper');
        expect(localStorage.getItem('bookvoice.mode')).toBe('system');
    });

    it('legacy colon keys still migrate', () => {
        localStorage.setItem('bookvoice:mode', 'dark');
        localStorage.setItem('bookvoice:palette', 'sage');
        const { result } = renderHook(() => useTheme());
        expect(result.current.mode).toBe('dark');
        expect(result.current.palette).toBe('sage');
        expect(result.current.effectiveMode).toBe('dark');
    });

    it('every palette has a system swatch (gradient of both accents)', () => {
        for (const p of PALETTES) {
            expect(p.accents.system).toContain('linear-gradient');
            expect(getSwatchColor(p.id, 'system')).toBe(p.accents.system);
        }
    });
});
