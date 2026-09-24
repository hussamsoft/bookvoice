import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { PALETTES, getSwatchColor, resolveStoredTheme, useTheme } from './useTheme';

describe('Paper and Night appearance', () => {
    it('keeps Action swatches static and mode-specific', () => {
        expect(PALETTES).toHaveLength(1);
        expect(PALETTES[0].accents.light).toBe('#3a5a78');
        expect(PALETTES[0].accents.dark).toBe('#9dbbd6');
        expect(getSwatchColor('paper', 'system')).toContain('linear-gradient');
        expect(getSwatchColor('unknown', 'light')).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('maps legacy palette ids to Paper', () => {
        expect(resolveStoredTheme('sage', 'dark')).toMatchObject({
            palette: 'paper',
            mode: 'dark',
            paletteRewriteNeeded: true,
        });
        expect(resolveStoredTheme('night', null)).toMatchObject({ palette: 'paper', mode: 'dark' });
        expect(resolveStoredTheme(null, null)).toMatchObject({ palette: 'paper', mode: 'light' });
    });
});

describe('theme mode behavior', () => {
    let listeners;
    let mqState;

    beforeEach(() => {
        localStorage.clear();
        listeners = [];
        mqState = { matches: false };
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            writable: true,
            value: vi.fn((query) => ({
                matches: query.includes('prefers-color-scheme: dark') ? mqState.matches : false,
                media: query,
                addEventListener: (_event, handler) => listeners.push(handler),
                removeEventListener: (_event, handler) => {
                    listeners = listeners.filter((listener) => listener !== handler);
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
        act(() => listeners.forEach((listener) => listener({ matches: value })));
    };

    it('starts in explicit Paper and does not write storage', () => {
        const { result } = renderHook(() => useTheme());
        expect(result.current.mode).toBe('light');
        expect(result.current.effectiveMode).toBe('light');
        expect(localStorage.getItem('bookvoice.mode')).toBeNull();
    });

    it('tracks the OS only when System is selected', () => {
        const { result } = renderHook(() => useTheme());
        act(() => result.current.setMode('system'));
        setSystemDark(true);
        expect(result.current.effectiveMode).toBe('dark');
        expect(document.documentElement.dataset.mode).toBe('dark');
    });

    it('persists explicit Night and toggles back to Paper', () => {
        const { result } = renderHook(() => useTheme());
        act(() => result.current.setMode('dark'));
        expect(localStorage.getItem('bookvoice.mode')).toBe('dark');
        setSystemDark(false);
        expect(result.current.effectiveMode).toBe('dark');
        act(() => result.current.toggleMode());
        expect(result.current.mode).toBe('light');
    });

    it('self-heals corrupt values and legacy colon keys', () => {
        localStorage.setItem('bookvoice.palette', 'not-a-palette');
        localStorage.setItem('bookvoice.mode', 'chartreuse');
        const { result } = renderHook(() => useTheme());
        expect(result.current.palette).toBe('paper');
        expect(result.current.mode).toBe('light');
        expect(localStorage.getItem('bookvoice.palette')).toBe('paper');
        expect(localStorage.getItem('bookvoice.mode')).toBe('light');

        localStorage.clear();
        localStorage.setItem('bookvoice:mode', 'dark');
        localStorage.setItem('bookvoice:palette', 'sage');
        const migrated = renderHook(() => useTheme());
        expect(migrated.result.current.mode).toBe('dark');
        expect(migrated.result.current.palette).toBe('paper');
    });
});
