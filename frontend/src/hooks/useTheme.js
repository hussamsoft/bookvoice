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

function readCssVar(name, fallback) {
    if (typeof window === 'undefined') return fallback;
    const value = window.getComputedStyle(document.documentElement)
        .getPropertyValue(name).trim();
    return value || fallback;
}

function readCssVarFor(palette, mode, name, fallback) {
    if (typeof window === 'undefined') return fallback;
    const probe = document.createElement('div');
    probe.dataset.palette = palette;
    probe.dataset.mode = mode;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    document.body.appendChild(probe);
    const value = window.getComputedStyle(probe).getPropertyValue(name).trim();
    probe.remove();
    return value || fallback;
}

export function getSwatchColor(palette, mode) {
    return readCssVarFor(palette, mode, '--accent', '#5f4bd8');
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
