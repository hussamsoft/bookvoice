import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronDown, Moon, Palette, Sun } from 'lucide-react';
import { readStoredString, writeStoredString } from '../utils/storage';

const SettingsPanel = lazy(() => import('./SettingsPanel'));

const PALETTES = [
    { id: 'paper', name: 'Paper Slate', icon: '📄' },
    { id: 'blue', name: 'Ethereal Blue', icon: '🌊' },
    { id: 'sage', name: 'Sage Green', icon: '🌿' },
    { id: 'plum', name: 'Muted Plum', icon: '🍇' },
    { id: 'sand', name: 'Sand Clay', icon: '🏺' },
];

function prefersColorSchemeDark() {
    if (typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function TitleBar({ currentMode, modeLabels }) {
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
    const [showPaletteMenu, setShowPaletteMenu] = useState(false);

    useEffect(() => {
        document.documentElement.dataset.palette = palette;
        document.documentElement.dataset.mode = mode;
        writeStoredString('bookvoice.palette', palette);
        writeStoredString('bookvoice.mode', mode);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
            const dark = mode === 'dark';
            const bgColors = {
                paper: dark ? '#161513' : '#f7f5f1',
                blue: dark ? '#0f172a' : '#f0f4f8',
                sage: dark ? '#052e16' : '#f0fdf4',
                plum: dark ? '#1e0a2e' : '#faf5ff',
                sand: dark ? '#1c0f08' : '#fef7ed',
            };
            meta.setAttribute('content', bgColors[palette] || '#f7f5f1');
        }
    }, [palette, mode]);

    const dark = mode === 'dark';
    const currentPalette = PALETTES.find(p => p.id === palette) || PALETTES[0];

    return (
        <div className="titlebar">
            <div className="titlebar-brand">
                <h1>BookVoice</h1>
            </div>
            <div className="titlebar-current-mode">
                {currentMode && <span className="current-mode-label">{modeLabels[currentMode] || currentMode}</span>}
            </div>
            <div className="titlebar-tools">
                <Palette className="titlebar-sparkle" data-testid="titlebar-palette" size={16} aria-hidden="true" />
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
                        <div className="theme-selector-menu" role="menu">
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
        paper: mode === 'dark' ? '#9dbbd6' : '#3a5a78',
        blue: mode === 'dark' ? '#60a5fa' : '#3b82f6',
        sage: mode === 'dark' ? '#4ade80' : '#16a34a',
        plum: mode === 'dark' ? '#c084fc' : '#8b5cf6',
        sand: mode === 'dark' ? '#fb923c' : '#ea580c',
    };
    return colors[palette] || colors.paper;
}

export default TitleBar;
