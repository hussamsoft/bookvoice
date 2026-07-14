import React, { lazy, Suspense } from 'react';
import { BookOpen, Sparkles } from 'lucide-react';

const SettingsPanel = lazy(() => import('./SettingsPanel'));

/**
 * Application identity and status strip. The native shell deliberately uses
 * the standard Windows frame so snapping, resizing, and maximize behavior are
 * handled by the operating system.
 */
function TitleBar() {
    return (
        <div className="titlebar">
            <div className="titlebar-brand">
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
        </div>
    );
}

export default TitleBar;
