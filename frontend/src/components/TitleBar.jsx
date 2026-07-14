import React, { lazy, Suspense, useCallback, useState } from 'react';
import { BookOpen, Copy, Minus, Sparkles, Square, X } from 'lucide-react';
import {
    closeWindow,
    isNativeShell,
    minimizeWindow,
    toggleMaximizeWindow,
} from '../utils/nativeShell';

const SettingsPanel = lazy(() => import('./SettingsPanel'));

/**
 * Application title bar. In the native pywebview shell it replaces the OS
 * window chrome: the brand area is a drag region and the window controls
 * drive the frameless window through the launcher's WindowApi.
 */
function TitleBar() {
    const native = isNativeShell();
    const [maximized, setMaximized] = useState(false);

    const onToggleMaximize = useCallback(async () => {
        if (!native) return;
        setMaximized(await toggleMaximizeWindow());
    }, [native]);

    return (
        <div className="titlebar">
            <div
                className={`titlebar-drag ${native ? 'pywebview-drag-region' : ''}`}
                onDoubleClick={onToggleMaximize}
            >
                <BookOpen className="brand-icon" size={19} strokeWidth={1.6} aria-hidden="true" />
                <h1>BookVoice</h1>
                <p className="titlebar-tagline">Read with your ears</p>
            </div>
            <div className="titlebar-tools">
                <p className="app-status">
                    <Sparkles size={14} aria-hidden="true" /> Local reader · Private by default
                </p>
                <Suspense fallback={null}>
                    <SettingsPanel />
                </Suspense>
            </div>
            {native && (
                <div className="window-controls">
                    <button
                        type="button"
                        className="window-control"
                        aria-label="Minimize window"
                        title="Minimize"
                        onClick={() => minimizeWindow()}
                    >
                        <Minus size={16} aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        className="window-control"
                        aria-label={maximized ? 'Restore window' : 'Maximize window'}
                        title={maximized ? 'Restore' : 'Maximize'}
                        onClick={onToggleMaximize}
                    >
                        {maximized ? (
                            <Copy size={14} aria-hidden="true" />
                        ) : (
                            <Square size={13} aria-hidden="true" />
                        )}
                    </button>
                    <button
                        type="button"
                        className="window-control window-control-close"
                        aria-label="Close window"
                        title="Close"
                        onClick={() => closeWindow()}
                    >
                        <X size={16} aria-hidden="true" />
                    </button>
                </div>
            )}
        </div>
    );
}

export default TitleBar;
