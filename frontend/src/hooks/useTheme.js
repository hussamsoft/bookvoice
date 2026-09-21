import { useEffect, useState } from 'react';
import { readStoredString, writeStoredString } from '../utils/storage';

/**
 * Theme (palette + light/dark) ownership for the whole app.
 *
 * Extracted from the old TitleBar so both the top bar's quick toggle and the
 * Settings appearance section drive the same state. Keeps <html> data
 * attributes and the meta theme-color in sync with tokens.css.
 *
 * Accent swatches for the Settings picker come from a static map below,
 * keyed by palette × mode. The previous implementation appended a probe
 * `<div data-palette=…>` and asked `getComputedStyle` for `--accent`, but
 * every palette rule in tokens.css is scoped to `:root[data-palette=…]`, so
 * the probe never matched and all ten swatches resolved to the *active*
 * accent. The probe also mutated the DOM during render and forced layout —
 * unsafe under StrictMode and concurrent rendering.
 */
export const PALETTES = [
    {
        id: 'paper',
        name: 'Aurora Ink',
        accents: { light: '#5f4bd8', dark: '#a08dfb' },
    },
    {
        id: 'blue',
        name: 'Cobalt Haze',
        accents: { light: '#2f5fe0', dark: '#6f9bff' },
    },
    {
        id: 'sage',
        name: 'Moss Glow',
        accents: { light: '#0e8a5c', dark: '#5fd6a4' },
    },
    {
        id: 'plum',
        name: 'Violet Dusk',
        accents: { light: '#7a3ff0', dark: '#c79bff' },
    },
    {
        id: 'sand',
        name: 'Ember Dusk',
        accents: { light: '#b05e10', dark: '#f0a860' },
    },
];

function prefersColorSchemeDark() {
    if (typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function readCssVar(name, fallback) {
    if (typeof window === 'undefined') return fallback;
    const value = window.getComputedStyle(document.documentElement)
        .getPropertyValue(name).trim();
    return value || fallback;
}

export function getSwatchColor(palette, mode) {
    const entry = PALETTES.find((p) => p.id === palette);
    return entry?.accents?.[mode] || '#5f4bd8';
}

export function useTheme() {
    const [palette, setPalette] = useState(() =>
        readStoredString('bookvoice.palette', {
            legacyKeys: ['bookvoice:palette'],
            fallback: 'paper',
        })
    );
    const [mode, setMode] = useState(() =>
        readStoredString('bookvoice.mode', {
            legacyKeys: ['bookvoice:mode', 'bookvoice.theme'],
            fallback: prefersColorSchemeDark() ? 'dark' : 'light',
        })
    );

    useEffect(() => {
        document.documentElement.dataset.palette = palette;
        document.documentElement.dataset.mode = mode;
        writeStoredString('bookvoice.palette', palette);
        writeStoredString('bookvoice.mode', mode);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
            meta.setAttribute('content', readCssVar('--bg', '#0d0d17'));
        }
    }, [palette, mode]);

    return {
        palette,
        mode,
        setPalette,
        setMode,
        toggleMode: () => setMode(mode === 'dark' ? 'light' : 'dark'),
    };
}
