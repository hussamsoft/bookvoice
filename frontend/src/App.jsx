import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/shell/Sidebar';
import TopBar from './components/shell/TopBar';
import HomeView from './components/shell/HomeView';
import LibraryView from './components/shell/LibraryView';
import SettingsView from './components/shell/SettingsView';
import { engineStatusFromTts } from './components/shell/engineStatus';
import ConfirmDialog from './components/ui/ConfirmDialog';
import Shortcuts from './components/Shortcuts';
import { getAppView, setAppView, getLastBookId, setLastBookId } from './utils/appSession';
import { useKeyboardShortcuts } from './hooks/reader/useKeyboardShortcuts';
import { useTtsStatus } from './hooks/useTtsStatus';
import UpdateBanner from './components/UpdateBanner';
import { useTheme } from './hooks/useTheme';

const BookSession = lazy(() => import('./components/BookSession'));
const VoiceStudio = lazy(() => import('./components/VoiceStudio'));
const Reader = lazy(() => import('./components/reader/Reader'));

const VIEW_TITLES = {
    home: 'Home',
    library: 'Library',
    reader: 'Reader',
    scan: 'Scanner',
    studio: 'Voice Studio',
    settings: 'Settings',
};

// F-40: safety net for the transitionend-driven view swap — used only if
// the CSS transition event never arrives; never the expected path.
const TRANSITION_SAFETY_MS = 600;

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
    const [readerTitle, setReaderTitle] = useState(() => {
        const id = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('book') : null;
        return id ? 'Reader' : '';
    });
    const [studioProjectTitle, setStudioProjectTitle] = useState('');

    useEffect(() => {
        const onStudioProject = (event) => {
            setStudioProjectTitle(event.detail?.name || '');
        };
        window.addEventListener('bookvoice:studio-project', onStudioProject);
        return () => window.removeEventListener('bookvoice:studio-project', onStudioProject);
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

    // F-40: the swap is driven by the real CSS fade (transitionend), not a
    // duplicated JS copy of the duration. Reduced-motion users get an
    // effectively instant swap — base.css forces transition-duration to
    // 0.01ms, so the event arrives ~immediately. The timeout is a safety
    // net for the case where no transition event ever fires (tab throttled
    // in the background, or transition:none from an unstyled first paint).
    const stageRef = useRef(null);
    useEffect(() => {
        if (view === prevViewRef.current) {
            // Rapid double-switch: view returned to the displayed screen
            // before the swap. Reset transitioning so the stage doesn't
            // stay hidden.
            setTransitioning(false);
            return undefined;
        }
        setTransitioning(true);
        setDisplayView(prevViewRef.current);
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            stage?.removeEventListener('transitionend', onEnd);
            clearTimeout(guard);
            prevViewRef.current = view;
            setDisplayView(view);
            setTransitioning(false);
        };
        const stage = stageRef.current;
        const onEnd = (event) => {
            if (event.target !== stage || event.propertyName !== 'opacity') return;
            finish();
        };
        const guard = setTimeout(finish, TRANSITION_SAFETY_MS);
        stage?.addEventListener('transitionend', onEnd);
        return () => {
            done = true;
            stage?.removeEventListener('transitionend', onEnd);
            clearTimeout(guard);
        };
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

    /**
     * Enter the reader for a book (Home/Library rows, added files, deep links).
     *
     * F-39 decision: this deliberately does NOT call setAppView('reader').
     * 'reader' is not a restorable view — appSession rejects it by design —
     * because a bare Reader mount has no document to show. The entry points
     * that must survive a restart write `?book=<id>` into the URL (above),
     * and a fresh launch restores via that param; Home also surfaces the
     * last book as the continue card. Persisting 'reader' without a param
     * would restore an empty shell.
     */
    const openBook = useCallback((book) => {
        const id = book?.id;
        if (id == null) return;
        setReaderTitle(book.title || 'Reader');
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
    // F-34: saving a scan session clears the guard — the next sidebar click
    // must not claim there is unsaved work.
    const markScanClean = useCallback(() => setScanDirty(false), []);

    const reader = <Reader key={`reader-${readerEpoch}`} />;

    // F-24/F-40: the title describes the screen that is actually showing —
    // derived from displayView, so it can never name a view mid-fade-out.
    const contextTitle = displayView === 'reader'
        ? (readerTitle || VIEW_TITLES.reader)
        : displayView === 'studio'
            ? (studioProjectTitle || VIEW_TITLES.studio)
            : VIEW_TITLES[displayView] || '';

    return (
        <div className="app-shell">
            <a href="#main-content" className="skip-link">Skip to main content</a>
            <UpdateBanner />
            <Sidebar view={view} onNavigate={navigate} />
            <div className="app-column">
                <header className="main-header">
                    <TopBar
                        title={contextTitle}
                        engineStatus={engineStatus}
                        theme={theme}
                        onThemeToggle={theme.toggleMode}
                        returnToBookDisabled={displayView !== 'reader' && Boolean(readerTitle)}
                    />
                </header>
                <main id="main-content" className="main-content">
                    <Suspense fallback={
                        <div className="loading-state" role="status">
                            {view === 'reader' ? 'Opening your book…' : `Loading ${VIEW_TITLES[view] || 'app'}…`}
                        </div>
                    }>
                        <div className={`mode-stage ${transitioning ? 'is-transitioning' : ''}`} ref={stageRef}>
                            {displayView === 'home' && (
                                <HomeView
                                    lastBookId={lastBookId}
                                    onOpenBook={openBook}
                                    onNavigate={navigate}
                                />
                            )}
                            {displayView === 'library' && (
                                <LibraryView onOpenBook={openBook} />
                            )}
                            {displayView === 'reader' && reader}
                            {displayView === 'scan' && (
                                <BookSession
                                    key={`scan-${workspaceEpoch}`}
                                    epoch={workspaceEpoch}
                                    onDirty={markScanDirty}
                                    onSaved={markScanClean}
                                    onOpenBook={openBook}
                                />
                            )}
                            {displayView === 'studio' && (
                                <VoiceStudio key={`studio-${workspaceEpoch}`} />
                            )}
                            {displayView === 'settings' && <SettingsView />}
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
