import { useEffect, useState } from 'react';
import { readStoredString, writeStoredString } from '../utils/storage';

/**
 * Theme (palette + light/dark/system) ownership for the whole app.
 *
 * Extracted from the old TitleBar so both the top bar's quick toggle and the
 * Settings appearance section drive the same state. Keeps <html> data
 * attributes and the meta theme-color in sync with tokens.css.
 *
 * F-35: `mode` is the user's CHOICE — 'system' (the default), 'light', or
 * 'dark'. 'system' follows prefers-color-scheme live via a matchMedia
 * subscription; the chosen value, never the resolved one, is what goes to
 * storage. Fresh installs write nothing until the user picks, so the OS
 * keeps owning the value. Stored values outside the known sets (hand-edited
 * or stale from an older build) self-heal: the hook falls back to the
 * default and rewrites storage.
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
        accents: {
            light: '#5f4bd8',
            dark: '#a08dfb',
            system: 'linear-gradient(135deg, #5f4bd8 0 50%, #a08dfb 50% 100%)',
        },
    },
    {
        id: 'blue',
        name: 'Cobalt Haze',
        accents: {
            light: '#2f5fe0',
            dark: '#6f9bff',
            system: 'linear-gradient(135deg, #2f5fe0 0 50%, #6f9bff 50% 100%)',
        },
    },
    {
        id: 'sage',
        name: 'Moss Glow',
        accents: {
            light: '#0e8a5c',
            dark: '#5fd6a4',
            system: 'linear-gradient(135deg, #0e8a5c 0 50%, #5fd6a4 50% 100%)',
        },
    },
    {
        id: 'plum',
        name: 'Violet Dusk',
        accents: {
            light: '#7a3ff0',
            dark: '#c79bff',
            system: 'linear-gradient(135deg, #7a3ff0 0 50%, #c79bff 50% 100%)',
        },
    },
    {
        id: 'sand',
        name: 'Ember Dusk',
        accents: {
            light: '#b05e10',
            dark: '#f0a860',
            system: 'linear-gradient(135deg, #b05e10 0 50%, #f0a860 50% 100%)',
        },
    },
];

export const MODES = ['system', 'light', 'dark'];

export function isKnownPalette(value) {
    return PALETTES.some((palette) => palette.id === value);
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
 * Pure validation used by both the hook and tests: invalid stored values
 * fall back to the defaults and are flagged so storage can be rewritten.
 * `null` means "nothing stored" (use the default WITHOUT persisting).
 */
export function resolveStoredTheme(rawPalette, rawMode) {
    const paletteOk = rawPalette === null || isKnownPalette(rawPalette);
    const modeOk = rawMode === null || isKnownMode(rawMode);
    return {
        palette: paletteOk && rawPalette !== null ? rawPalette : 'paper',
        mode: modeOk && rawMode !== null ? rawMode : 'system',
        paletteRewriteNeeded: rawPalette !== null && !paletteOk,
        modeRewriteNeeded: rawMode !== null && !modeOk,
    };
}

export function getSwatchColor(palette, mode) {
    const entry = PALETTES.find((p) => p.id === palette);
    return entry?.accents?.[mode] || '#5f4bd8';
}

export function useTheme() {
    // Raw reads run once; legacy colon keys keep working through storage.js.
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

    // F-35: a corrupt stored value self-heals — storage is rewritten to the
    // fallback once, at mount.
    useEffect(() => {
        if (initial.paletteRewriteNeeded) writeStoredString('bookvoice.palette', initial.palette);
        if (initial.modeRewriteNeeded) writeStoredString('bookvoice.mode', initial.mode);
    }, [initial]);

    // Follow the OS live while in system mode.
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
        if (meta) {
            meta.setAttribute('content', readCssVar('--bg', '#0d0d17'));
        }
    }, [palette, effectiveMode]);

    // Persistence is choice-driven, never effect-driven: defaults stay
    // unwritten so a fresh install keeps following the OS, and only an
    // explicit set (Settings radio, top-bar toggle) writes a value.
    const setPalette = (next) => {
        const safe = isKnownPalette(next) ? next : 'paper';
        setPaletteState(safe);
        writeStoredString('bookvoice.palette', safe);
    };
    const setMode = (next) => {
        const safe = isKnownMode(next) ? next : 'system';
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
