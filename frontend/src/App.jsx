import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AudioWaveform, FileText, ScanLine } from 'lucide-react';
import TitleBar from './components/TitleBar';
import ConfirmDialog from './components/ui/ConfirmDialog';
import { getAppMode, setAppMode } from './utils/appSession';

const BookSession = lazy(() => import('./components/BookSession'));
const PdfViewer = lazy(() => import('./components/PdfViewer'));
const VoiceStudio = lazy(() => import('./components/VoiceStudio'));

const MODE_LABELS = {
    pdf: 'reader',
    camera: 'scanner',
    studio: 'voice studio',
};

const MODE_HINTS = {
    pdf: 'Read PDF, EPUB, or text files',
    camera: 'Capture physical books with your camera',
    studio: 'Create and repair speech recordings',
};

const MODE_ICONS = {
    pdf: FileText,
    camera: ScanLine,
    studio: AudioWaveform,
};

const MODE_SHORT_LABELS = {
    pdf: 'Read',
    camera: 'Scan',
    studio: 'Studio',
};

function App() {
    const [mode, setMode] = useState(getAppMode);
    const [sessionDirty, setSessionDirty] = useState(false);
    const [pendingMode, setPendingMode] = useState(null);
    const [transitioning, setTransitioning] = useState(false);
    const [displayMode, setDisplayMode] = useState(mode);
    const prevModeRef = useRef(mode);
    // Epoch increments on every mode switch so in-flight async handlers from a
    // previous mode can detect they're stale and bail out (no state update on
    // unmounted/wrong-mode components, no phantom toasts).
    const epochRef = useRef(0);

    useEffect(() => {
        if (mode !== prevModeRef.current) {
            setTransitioning(true);
            setDisplayMode(prevModeRef.current);
            const timer = setTimeout(() => {
                setDisplayMode(mode);
                setTransitioning(false);
                prevModeRef.current = mode;
            }, 200);
            return () => clearTimeout(timer);
        }
        // Rapid double-switch: mode returned to previous before timer fired.
        // Reset transitioning so the stage doesn't stay invisible.
        setTransitioning(false);
    }, [mode]);


    useEffect(() => {
        const track = document.querySelector('.mode-switcher-track');
        const indicator = document.querySelector('.mode-indicator');
        if (!track || !indicator) return;
        const position = () => {
            const segments = track.querySelectorAll('.mode-segment');
            const modeKeys = Object.keys(MODE_LABELS);
            const index = modeKeys.indexOf(mode);
            if (index < 0 || !segments[index]) return;
            const segment = segments[index];
            const trackRect = track.getBoundingClientRect();
            const segmentRect = segment.getBoundingClientRect();
            indicator.style.width = `${segmentRect.width}px`;
            indicator.style.transform = `translateX(${segmentRect.left - trackRect.left - 2}px)`;
        };
        position();
        // ResizeObserver may not exist in all environments (e.g., jsdom tests).
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(position);
            observer.observe(track);
            window.addEventListener('resize', position);
            return () => {
                observer.disconnect();
                window.removeEventListener('resize', position);
            };
        }
        return undefined;
    }, [mode]);

    const switchTo = (next) => {
        epochRef.current += 1;
        setSessionDirty(false);
        setMode(next);
        setAppMode(next);
    };

    const requestMode = (next) => {
        if (next === mode) return;
        if (sessionDirty) {
            setPendingMode(next);
            return;
        }
        switchTo(next);
    };

    const confirmPendingMode = () => {
        const next = pendingMode;
        setPendingMode(null);
        if (!next) return;
        switchTo(next);
    };

    // ARIA tabs pattern: arrow keys / Home / End move the selected mode
    // tab with roving tabindex; mouse and touch keep their click behavior.
    const handleModeSwitcherKeyDown = (event) => {
        const key = event.key;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
        const tabs = Array.from(event.currentTarget.querySelectorAll('[role="tab"]'));
        const index = tabs.indexOf(document.activeElement);
        if (index === -1) return;
        event.preventDefault();
        const modeKeys = Object.keys(MODE_LABELS);
        let nextIndex;
        if (key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
        else if (key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
        else if (key === 'Home') nextIndex = 0;
        else nextIndex = tabs.length - 1;
        tabs[nextIndex]?.focus();
        // Directly update tabindex for immediate effect (avoids render timing issues)
        tabs.forEach((tab, i) => { tab.tabIndex = i === nextIndex ? 0 : -1; });
        tabs[nextIndex]?.click();
    };


    return (
        <div className="app-shell">
            <header className="main-header">
                <TitleBar currentMode={mode} modeLabels={MODE_LABELS} />
                <nav className="mode-switcher" aria-label="Reading mode">
                    <div className="mode-switcher-track" role="tablist" onKeyDown={handleModeSwitcherKeyDown}>
                        {Object.keys(MODE_LABELS).map((modeKey) => {
                            const Icon = MODE_ICONS[modeKey];
                            const isActive = mode === modeKey;
                            return (
                                <button
                                    key={modeKey}
                                    type="button"
                                    className={`mode-segment ${isActive ? 'is-active' : ''}`}
                                    role="tab"
                                    aria-selected={isActive}
                                    aria-label={`${MODE_LABELS[modeKey]} mode`}
                                    tabIndex={isActive ? 0 : -1}
                                    onClick={() => requestMode(modeKey)}
                                >
                                    <Icon size={16} aria-hidden="true" />
                                    <span>{MODE_SHORT_LABELS[modeKey]}</span>
                                </button>
                            );
                        })}
                        <span className="mode-indicator" aria-hidden="true" />
                    </div>
                    <p className="mode-hint">{MODE_HINTS[mode]}</p>
                </nav>
            </header>

            <main className="main-content reading-stage">
                <Suspense fallback={
                    <div className="loading-state" role="status">
                        Loading {MODE_LABELS[mode] || 'app'}…
                    </div>
                }>
                    <div className={`mode-stage ${transitioning ? 'is-transitioning' : ''}`}>
                        {displayMode === 'camera' ? (
                            <BookSession
                                key={`camera-${epochRef.current}`}
                                epoch={epochRef.current}
                                onDirty={() => setSessionDirty(true)}
                            />
                        ) : displayMode === 'studio' ? (
                            <VoiceStudio key={`studio-${epochRef.current}`} />
                        ) : (
                            <PdfViewer
                                key={`pdf-${epochRef.current}`}
                                epoch={epochRef.current}
                                onDirty={() => setSessionDirty(true)}
                            />
                        )}
                    </div>
                </Suspense>
            </main>

            <ConfirmDialog
                open={pendingMode !== null}
                title="Leave this session?"
                message="Switching modes leaves your current reading session. Your book and progress stay saved."
                confirmLabel="Switch mode"
                onConfirm={confirmPendingMode}
                onCancel={() => setPendingMode(null)}
            />
        </div>
    );
}

export default App;
