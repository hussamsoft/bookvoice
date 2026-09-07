import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/shell/Sidebar';
import TopBar from './components/shell/TopBar';
import HomeView from './components/shell/HomeView';
import LibraryView from './components/shell/LibraryView';
import { engineStatusFromTts } from './components/shell/engineStatus';
import ConfirmDialog from './components/ui/ConfirmDialog';
import Shortcuts from './components/Shortcuts';
import { getAppView, setAppView, getLastBookId, setLastBookId } from './utils/appSession';
import { useKeyboardShortcuts } from './hooks/reader/useKeyboardShortcuts';
import { useTtsStatus } from './hooks/useTtsStatus';
import { useTheme } from './hooks/useTheme';

const BookSession = lazy(() => import('./components/BookSession'));
const PdfViewer = lazy(() => import('./components/PdfViewer'));
const VoiceStudio = lazy(() => import('./components/VoiceStudio'));
const Reader = lazy(() => import('./components/reader/Reader'));

const VIEW_TITLES = {
    home: 'Home',
    library: 'Library',
    reader: 'Reading',
    scan: 'Scan pages',
    studio: 'Voice Studio',
};

export default function App() {
    const [view, setViewState] = useState(() => {
        // A `?book=` deep link opens the reader directly (desktop shell,
        // .bookvoice double-click, addresses card).
        if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('book')) {
            return 'reader';
        }
        return getAppView();
    });
    const [readerEpoch, setReaderEpoch] = useState(0);
    const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
    const [lastBookId, setLastBookIdState] = useState(getLastBookId);
    const [scanDirty, setScanDirty] = useState(false);
    const [pendingView, setPendingView] = useState(null);
    const [transitioning, setTransitioning] = useState(false);
    const [displayView, setDisplayView] = useState(view);
    const prevViewRef = useRef(view);

    // Stage A feature flag. The new reader composition is being extracted
    // from PdfViewer.jsx: `?reader=new` previews it while the production
    // PdfViewer stays the default (including for `?reader=old` or any
    // other value). Making the new reader the default — and deleting the
    // flag — is a separate, later decision.
    const useNewReader = useMemo(() => {
        if (typeof window === 'undefined') return false;
        return new URLSearchParams(window.location.search).get('reader') === 'new';
    }, []);

    const theme = useTheme();
    const tts = useTtsStatus();
    const engineStatus = engineStatusFromTts(tts);

    // Global `?` opens the keyboard shortcuts sheet. The per-view keyboard
    // hooks (Space / PageUp / F / etc.) live in the view components; this
    // handler is intentionally narrow so the `?` shortcut works anywhere.
    const [showShortcuts, setShowShortcuts] = useState(false);
    useKeyboardShortcuts({
        onShowShortcuts: () => setShowShortcuts(true),
    });

    useEffect(() => {
        if (view !== prevViewRef.current) {
            setTransitioning(true);
            setDisplayView(prevViewRef.current);
            const timer = setTimeout(() => {
                setDisplayView(view);
                setTransitioning(false);
                prevViewRef.current = view;
            }, 200);
            return () => clearTimeout(timer);
        }
        // Rapid double-switch: view returned to the previous one before the
        // timer fired. Reset transitioning so the stage doesn't stay hidden.
        setTransitioning(false);
    }, [view]);

    const navigate = useCallback((next) => {
        if (next === 'reader') return; // readers are entered via openBook only
        if (next === view) return;
        if (scanDirty && view === 'scan' && next !== 'scan') {
            setPendingView(next);
            return;
        }
        if (next === 'scan' || next === 'studio') setWorkspaceEpoch((n) => n + 1);
        setViewState(next);
        setAppView(next);
    }, [view, scanDirty]);

    const confirmPendingView = () => {
        const next = pendingView;
        setPendingView(null);
        if (!next) return;
        setScanDirty(false);
        setWorkspaceEpoch((n) => n + 1);
        setViewState(next);
        setAppView(next);
    };

    /** Enter the reader for a book (Home/Library rows, added files, deep links). */
    const openBook = useCallback((book) => {
        const id = book?.id;
        if (id == null) return;
        setLastBookId(id);
        setLastBookIdState(String(id));
        try {
            window.history.replaceState(null, '', `/?book=${id}`);
        } catch {
            /* Deep-link sync is best-effort (e.g. sandboxed frames). */
        }
        setReaderEpoch((n) => n + 1);
        setViewState('reader');
    }, []);

    const markScanDirty = useCallback(() => setScanDirty(true), []);

    const reader = useNewReader ? (
        <Reader key={`reader-${readerEpoch}`} />
    ) : (
        <PdfViewer
            key={`reader-${readerEpoch}`}
            onDirty={() => { /* progress persists; leaving the reader is always safe */ }}
            onExit={() => {
                try {
                    window.history.replaceState(null, '', '/');
                } catch {
                    /* Deep-link cleanup is best-effort. */
                }
                navigate('library');
            }}
        />
    );

    const contextTitle = view === 'reader' ? VIEW_TITLES.reader : VIEW_TITLES[view] || '';

    return (
        <div className="app-shell">
            <a href="#main-content" className="skip-link">Skip to main content</a>
            <Sidebar view={view} onNavigate={navigate} />
            <div className="app-column">
                <header className="main-header">
                    <TopBar
                        title={contextTitle}
                        engineStatus={engineStatus}
                        theme={theme}
                        onThemeToggle={theme.toggleMode}
                    />
                </header>
                <main id="main-content" className="main-content">
                    <Suspense fallback={
                        <div className="loading-state" role="status">
                            {view === 'reader' ? 'Opening your book…' : `Loading ${VIEW_TITLES[view] || 'app'}…`}
                        </div>
                    }>
                        <div className={`mode-stage ${transitioning ? 'is-transitioning' : ''}`}>
                            {displayView === 'home' && (
                                <HomeView
                                    lastBookId={lastBookId}
                                    onOpenBook={openBook}
                                    onNavigate={navigate}
                                    onError={() => {}}
                                />
                            )}
                            {displayView === 'library' && (
                                <LibraryView onOpenBook={openBook} onError={() => {}} />
                            )}
                            {displayView === 'reader' && reader}
                            {displayView === 'scan' && (
                                <BookSession
                                    key={`scan-${workspaceEpoch}`}
                                    epoch={workspaceEpoch}
                                    onDirty={markScanDirty}
                                />
                            )}
                            {displayView === 'studio' && (
                                <VoiceStudio key={`studio-${workspaceEpoch}`} />
                            )}
                        </div>
                    </Suspense>
                </main>
            </div>

            <ConfirmDialog
                open={pendingView !== null}
                title="Leave the scan session?"
                message="Pages captured in this session are not saved yet. Save to Library from the scan toolbar to keep them."
                confirmLabel="Leave without saving"
                onConfirm={confirmPendingView}
                onCancel={() => setPendingView(null)}
            />
            <Shortcuts
                open={showShortcuts}
                onClose={() => setShowShortcuts(false)}
            />
        </div>
    );
}
