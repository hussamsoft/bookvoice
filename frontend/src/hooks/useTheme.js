import { useEffect, useState } from 'react';
import { readStoredString, writeStoredString } from '../utils/storage';

/**
 * Theme ownership for the whole app. Paper is the default light mode and
 * Night is the default dark mode; System is an explicit opt-in. The legacy
 * palette values normalize to Paper while their existing light/dark choice
 * is preserved.
 */
export const PALETTES = [
    {
        id: 'paper',
        name: 'Paper',
        accents: {
            light: '#3a5a78',
            dark: '#9dbbd6',
            system: 'linear-gradient(135deg, #3a5a78 0 50%, #9dbbd6 50% 100%)',
        },
    },
];

export const MODES = ['system', 'light', 'dark'];

export const THEME_MODE_OPTIONS = [
    { id: 'light', name: 'Paper', description: 'Warm, quiet light' },
    { id: 'dark', name: 'Night', description: 'Low-light listening' },
    { id: 'system', name: 'System', description: 'Follow this device' },
];

const LEGACY_PALETTES = new Set(['blue', 'sage', 'plum', 'sand']);

export function isKnownPalette(value) {
    return value === 'paper';
}

export function isKnownMode(value) {
    return MODES.includes(value);
}

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

/**
 * Pure validation used by both the hook and tests. A legacy palette is
 * rewritten to Paper, while a fresh install starts in explicit Paper.
 */
export function resolveStoredTheme(rawPalette, rawMode) {
    const paletteOk = rawPalette === null || rawPalette === 'paper';
    const modeOk = rawMode === null || isKnownMode(rawMode);
    const paletteRewriteNeeded = rawPalette !== null
        && (!paletteOk || LEGACY_PALETTES.has(rawPalette) || rawPalette === 'night');
    let mode = modeOk && rawMode !== null ? rawMode : 'light';
    if (rawPalette === 'night' && rawMode === null) mode = 'dark';
    return {
        palette: 'paper',
        mode,
        paletteRewriteNeeded,
        modeRewriteNeeded: rawMode !== null && !modeOk,
    };
}

export function getSwatchColor(palette, mode) {
    const entry = PALETTES.find((p) => p.id === palette) || PALETTES[0];
    return entry.accents[mode] || entry.accents.light;
}

export function useTheme() {
    const [initial] = useState(() => {
        const rawPalette = readStoredString('bookvoice.palette', {
            legacyKeys: ['bookvoice:palette'],
            fallback: null,
        });
        const rawMode = readStoredString('bookvoice.mode', {
            legacyKeys: ['bookvoice:mode', 'bookvoice.theme'],
            fallback: null,
        });
        return resolveStoredTheme(rawPalette, rawMode);
    });
    const [palette, setPaletteState] = useState(initial.palette);
    const [mode, setModeState] = useState(initial.mode);
    const [systemDark, setSystemDark] = useState(() => prefersColorSchemeDark());

    useEffect(() => {
        if (initial.paletteRewriteNeeded) writeStoredString('bookvoice.palette', initial.palette);
        if (initial.modeRewriteNeeded) writeStoredString('bookvoice.mode', initial.mode);
    }, [initial]);

    useEffect(() => {
        if (mode !== 'system' || typeof window.matchMedia !== 'function') return undefined;
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = (event) => setSystemDark(event.matches);
        setSystemDark(media.matches);
        if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', onChange);
            return () => media.removeEventListener('change', onChange);
        }
        if (typeof media.addListener === 'function') {
            media.addListener(onChange);
            return () => media.removeListener(onChange);
        }
        return undefined;
    }, [mode]);

    const effectiveMode = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

    useEffect(() => {
        document.documentElement.dataset.palette = palette;
        document.documentElement.dataset.mode = effectiveMode;
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', readCssVar('--bg', '#f7f5f1'));
    }, [palette, effectiveMode]);

    const setPalette = (_next) => {
        setPaletteState('paper');
        writeStoredString('bookvoice.palette', 'paper');
    };
    const setMode = (next) => {
        const safe = isKnownMode(next) ? next : 'light';
        setModeState(safe);
        writeStoredString('bookvoice.mode', safe);
    };

    return {
        palette,
        mode,
        effectiveMode,
        setPalette,
        setMode,
        toggleMode: () => setMode(effectiveMode === 'dark' ? 'light' : 'dark'),
    };
}
