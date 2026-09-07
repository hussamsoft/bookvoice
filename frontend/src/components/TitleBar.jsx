import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ChevronDown, Moon, Sun } from 'lucide-react';
import { readStoredString, writeStoredString } from '../utils/storage';

const SettingsPanel = lazy(() => import('./SettingsPanel'));

const PALETTES = [
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

function TitleBar({ currentMode, modeLabels, modeSwitcher = null, contextTitle = null }) {
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
    const menuRef = useRef(null);
    const [showPaletteMenu, setShowPaletteMenu] = useState(false);
    useEffect(() => {
        if (!showPaletteMenu) return undefined;
        const closeOnOutside = (event) => {
            if (!menuRef.current?.contains(event.target)) setShowPaletteMenu(false);
        };
        const closeOnEscape = (event) => {
            if (event.key === 'Escape') setShowPaletteMenu(false);
        };
        const handleKeyDown = (event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const items = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') || []);
                const index = items.indexOf(document.activeElement);
                if (index === -1) return;
                const next = event.key === 'ArrowDown'
                    ? (index + 1) % items.length
                    : (index - 1 + items.length) % items.length;
                items[next]?.focus();
            } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                const items = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') || []);
                if (!items.length) return;
                const nextIndex = event.key === 'Home' ? 0 : items.length - 1;
                items[nextIndex]?.focus();
            }
        };
        document.addEventListener('click', closeOnOutside);
        document.addEventListener('keydown', closeOnEscape);
        document.addEventListener('keydown', handleKeyDown);
        const firstOption = menuRef.current?.querySelector('[role="menuitem"]');
        if (firstOption) firstOption.focus();
        return () => {
            document.removeEventListener('click', closeOnOutside);
            document.removeEventListener('keydown', closeOnEscape);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [showPaletteMenu]);



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

    const dark = mode === 'dark';
    const currentPalette = PALETTES.find(p => p.id === palette) || PALETTES[0];

    return (
        <div className="titlebar">
            <div className="titlebar-brand">
                <h1>BookVoice</h1>
            </div>
            <div className="titlebar-center">
                {modeSwitcher}
                {contextTitle ? (
                    <span className="titlebar-context">{contextTitle}</span>
                ) : (
                    currentMode && (
                        <span className="current-mode-label">{modeLabels[currentMode] || currentMode}</span>
                    )
                )}
            </div>
            <div className="titlebar-tools">
                <div className="theme-selector">
                    <button
                        type="button"
                        className="icon-btn theme-selector-trigger"
                        onClick={() => setShowPaletteMenu(!showPaletteMenu)}
                        aria-expanded={showPaletteMenu}
                        aria-haspopup="true"
                        aria-label={`Theme: ${currentPalette.name} ${mode}`}
                        title={`Theme: ${currentPalette.name} (${dark ? 'Dark' : 'Light'})`}
                    >
                        <span className="theme-selector-swatch" style={{ background: getSwatchColor(palette, mode) }} />
                        <span className="theme-selector-name">{currentPalette.name}</span>
                        <ChevronDown size={12} className={`theme-selector-chevron ${showPaletteMenu ? 'open' : ''}`} />
                    </button>
                    {showPaletteMenu && (
                        <div className="theme-selector-menu" role="menu" ref={menuRef}>
                            {PALETTES.map(p => (
                                <div key={p.id} className="theme-selector-palette-group">
                                    <button
                                        type="button"
                                        className={`theme-selector-option ${palette === p.id && !dark ? 'is-active' : ''}`}
                                        onClick={() => { setPalette(p.id); setMode('light'); setShowPaletteMenu(false); }}
                                        role="menuitem"
                                    >
                                        <span className="theme-selector-swatch" style={{ background: getSwatchColor(p.id, 'light') }} />
                                        <span>{p.name}</span>
                                        <span className="theme-selector-mode">Light</span>
                                    </button>
                                    <button
                                        type="button"
                                        className={`theme-selector-option ${palette === p.id && dark ? 'is-active' : ''}`}
                                        onClick={() => { setPalette(p.id); setMode('dark'); setShowPaletteMenu(false); }}
                                        role="menuitem"
                                    >
                                        <span className="theme-selector-swatch" style={{ background: getSwatchColor(p.id, 'dark') }} />
                                        <span>{p.name}</span>
                                        <span className="theme-selector-mode">Dark</span>
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    className="icon-btn theme-toggle"
                    onClick={() => setMode(dark ? 'light' : 'dark')}
                    aria-label={dark ? 'Use light mode' : 'Use dark mode'}
                    title={dark ? 'Use light mode' : 'Use dark mode'}
                >
                    {dark ? <Sun size={16} /> : <Moon size={16} />}
                </button>
                <Suspense fallback={null}>
                    <SettingsPanel />
                </Suspense>
            </div>
        </div>
    );
}

function getSwatchColor(palette, mode) {
    const colors = {
        paper: mode === 'dark' ? '#a08dfb' : '#5f4bd8',
        blue: mode === 'dark' ? '#6f9bff' : '#2f5fe0',
        sage: mode === 'dark' ? '#5fd6a4' : '#0e8a5c',
        plum: mode === 'dark' ? '#c79bff' : '#7a3ff0',
        sand: mode === 'dark' ? '#f0a860' : '#b05e10',
    };
    return colors[palette] || colors.paper;
}

export default TitleBar;
