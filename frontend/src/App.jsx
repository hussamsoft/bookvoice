import React, { lazy, Suspense, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useToast } from './components/Toast';

const BookSession = lazy(() => import('./components/BookSession'));
const PdfViewer = lazy(() => import('./components/PdfViewer'));
const SettingsPanel = lazy(() => import('./components/SettingsPanel'));

function App() {
    const toast = useToast();
    const [mode, setMode] = useState('pdf'); // 'camera' or 'pdf'
    const [sessionDirty, setSessionDirty] = useState(false);

    const requestMode = (next) => {
        if (next === mode) return;
        if (sessionDirty) {
            const ok = window.confirm(
                'Switching modes will leave your current reading session. Continue?'
            );
            if (!ok) return;
        }
        setSessionDirty(false);
        setMode(next);
        if (next === 'camera') {
            toast.info('Camera mode: capture a page to start.');
        }
    };

    return (
        <div className="app-container">
            <header className="main-header">
                <div
                    className="brand"
                    style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <BookOpen className="brand-icon" size={28} strokeWidth={1.5} />
                        <div>
                            <h1>BookVoice</h1>
                            <p>Turn any page into narration</p>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <Suspense fallback={null}>
                            <SettingsPanel />
                        </Suspense>
                        <button
                            className={`btn ${mode === 'camera' ? 'primary' : 'secondary'}`}
                            onClick={() => requestMode('camera')}
                        >
                            Camera Mode
                        </button>
                        <button
                            className={`btn ${mode === 'pdf' ? 'primary' : 'secondary'}`}
                            onClick={() => requestMode('pdf')}
                        >
                            PDF Mode
                        </button>
                    </div>
                </div>
            </header>

            <main className="main-content">
                <Suspense fallback={<div className="loading-state" role="status">Loading reader…</div>}>
                    {mode === 'camera' ? (
                        <BookSession key="camera" onDirty={() => setSessionDirty(true)} />
                    ) : (
                        <PdfViewer key="pdf" onDirty={() => setSessionDirty(true)} />
                    )}
                </Suspense>
            </main>
        </div>
    );
}

export default App;
