import React, { lazy, Suspense, useState } from 'react';
import { AudioWaveform, FileText, ScanLine } from 'lucide-react';
import { useToast } from './components/Toast';
import TitleBar from './components/TitleBar';
import ConfirmDialog from './components/ui/ConfirmDialog';
import { getAppMode, setAppMode } from './utils/appSession';

const BookSession = lazy(() => import('./components/BookSession'));
const PdfViewer = lazy(() => import('./components/PdfViewer'));
const VoiceStudio = lazy(() => import('./components/VoiceStudio'));

function App() {
    const toast = useToast();
    const [mode, setMode] = useState(getAppMode);
    const [sessionDirty, setSessionDirty] = useState(false);
    const [pendingMode, setPendingMode] = useState(null);

    const switchTo = (next) => {
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
        if (next === 'camera') {
            toast.info('Scan a page to start.');
        }
    };

    const confirmPendingMode = () => {
        const next = pendingMode;
        setPendingMode(null);
        if (!next) return;
        switchTo(next);
        if (next === 'camera') {
            toast.info('Scan a page to start.');
        }
    };

    return (
        <div className="app-shell">
            <header className="main-header">
                <TitleBar />
                <nav className="mode-switcher" aria-label="Reading mode">
                    <button
                        className={`mode-button ${mode === 'pdf' ? 'is-active' : ''}`}
                        aria-label="PDF reader"
                        aria-pressed={mode === 'pdf'}
                        onClick={() => requestMode('pdf')}
                    >
                        <FileText size={17} aria-hidden="true" />
                        <span>PDF reader</span>
                        <small>Open a book file</small>
                    </button>
                    <button
                        className={`mode-button ${mode === 'camera' ? 'is-active' : ''}`}
                        aria-label="Scan a page"
                        aria-pressed={mode === 'camera'}
                        onClick={() => requestMode('camera')}
                    >
                        <ScanLine size={17} aria-hidden="true" />
                        <span>Scan a page</span>
                        <small>Capture a physical book</small>
                    </button>
                    <button
                        className={`mode-button ${mode === 'studio' ? 'is-active' : ''}`}
                        aria-label="Voice Studio"
                        aria-pressed={mode === 'studio'}
                        onClick={() => requestMode('studio')}
                    >
                        <AudioWaveform size={17} aria-hidden="true" />
                        <span>Voice Studio</span>
                        <small>Create and repair speech</small>
                    </button>
                </nav>
            </header>

            <main className="main-content reading-stage">
                <Suspense fallback={<div className="loading-state" role="status">Loading reader…</div>}>
                    {mode === 'camera' ? (
                        <BookSession key="camera" onDirty={() => setSessionDirty(true)} />
                    ) : mode === 'studio' ? (
                        <VoiceStudio key="studio" />
                    ) : (
                        <PdfViewer key="pdf" onDirty={() => setSessionDirty(true)} />
                    )}
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
