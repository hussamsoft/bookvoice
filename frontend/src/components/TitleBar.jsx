import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Moon, Sparkles, Sun } from 'lucide-react';

const SettingsPanel = lazy(() => import('./SettingsPanel'));

/**
 * Application identity and status strip. The native shell deliberately uses
 * the standard Windows frame so snapping, resizing, and maximize behavior are
 * handled by the operating system.
 */
function TitleBar() {
    const [theme, setTheme] = useState(() => localStorage.getItem('bookvoice:theme') || 'light');

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('bookvoice:theme', theme);
    }, [theme]);

    const dark = theme === 'dark';
    return (
        <div className="titlebar">
            <div className="titlebar-brand">
                <h1>BookVoice</h1>
            </div>
            <div className="titlebar-tools">
                <Sparkles className="titlebar-sparkle" data-testid="titlebar-sparkle" size={16} aria-hidden="true" />
                <button
                    type="button"
                    className="icon-btn theme-toggle"
                    onClick={() => setTheme(dark ? 'light' : 'dark')}
                    aria-label={dark ? 'Use light theme' : 'Use dark theme'}
                    title={dark ? 'Use light theme' : 'Use dark theme'}
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

export default TitleBar;
