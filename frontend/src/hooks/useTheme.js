import { useEffect, useState } from 'react';
import { readStoredString, writeStoredString } from '../utils/storage';

/**
 * Theme (palette + light/dark) ownership for the whole app.
 *
 * Extracted from the old TitleBar so both the top bar's quick toggle and the
 * Settings appearance section drive the same state. Keeps <html> data
 * attributes and the meta theme-color in sync with tokens.css.
 */
export const PALETTES = [
    { id: 'paper', name: 'Aurora Ink' },
    { id: 'blue', name: 'Cobalt Haze' },
    { id: 'sage', name: 'Moss Glow' },
    { id: 'plum', name: 'Violet Dusk' },
    { id: 'sand', name: 'Ember Dusk' },
];

function prefersColorSchemeDark() {
    if (typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function getSwatchColor(palette, mode) {
    const colors = {
        paper: mode === 'dark' ? '#a08dfb' : '#5f4bd8',
        blue: mode === 'dark' ? '#6f9bff' : '#2f5fe0',
        sage: mode === 'dark' ? '#5fd6a4' : '#0e8a5c',
        plum: mode === 'dark' ? '#c79bff' : '#7a3ff0',
        sand: mode === 'dark' ? '#f0a860' : '#b05e10',
    };
    return colors[palette] || colors.paper;
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
            const dark = mode === 'dark';
            const bgColors = {
                paper: dark ? '#0d0d17' : '#eef0fa',
                blue: dark ? '#0a0f1e' : '#edf1fb',
                sage: dark ? '#0a1410' : '#eaf6ef',
                plum: dark ? '#120c1e' : '#f3effb',
                sand: dark ? '#16100a' : '#f9f3ea',
            };
            meta.setAttribute('content', bgColors[palette] || '#0d0d17');
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
