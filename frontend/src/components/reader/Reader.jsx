import { useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, Search, ZoomIn, ZoomOut } from 'lucide-react';
import { useBookmarks } from '../../hooks/reader/useBookmarks';
import { useKeyboardShortcuts } from '../../hooks/reader/useKeyboardShortcuts';
import { usePageResume } from '../../hooks/reader/usePageResume';
import { usePreparedLibrary } from '../../hooks/reader/usePreparedLibrary';
import { useReaderPageLifecycle } from '../../hooks/reader/useReaderPageLifecycle';
import { useReaderProgress } from '../../hooks/reader/useReaderProgress';
import { useReaderSearch } from '../../hooks/reader/useReaderSearch';
import { useReaderTransport } from '../../hooks/reader/useReaderTransport';
import { useReaderZoom } from '../../hooks/reader/useReaderZoom';
import PdfStage from './PdfStage';
import TextStage from './TextStage';

// Stage-A placeholder book: a fixed-length synthetic document so every
// hook (lifecycle clamping, search wrap-around, resume dialog) runs the
// same paths it will run against a real book. A.8 replaces this
// identity, the resolver, and the finder with the real document.
const PLACEHOLDER_TOTAL_PAGES = 100;
const PLACEHOLDER_PAGE_TEXT = (page) => `Page ${page} placeholder text.`;

// Wrap-around scan over the placeholder book so the search → jump flow
// is exercisable end to end. The real per-source finder (PDF text layer
// / server pages) lands in A.8.
function placeholderFindInDocument(needle, startPage) {
    const target = String(needle).trim().toLowerCase();
    for (let offset = 0; offset < PLACEHOLDER_TOTAL_PAGES; offset += 1) {
        const page = ((startPage - 1 + offset) % PLACEHOLDER_TOTAL_PAGES) + 1;
        if (PLACEHOLDER_PAGE_TEXT(page).toLowerCase().includes(target)) {
            return page;
        }
    }
    return null;
}

// Zoom is always allowed in the scaffold; a module-level constant keeps
// the wheel-handler identity stable for the native listener effect.
const canAlwaysZoom = () => true;

/**
 * Reader (new) — composition root for the migrated reader.
 *
 * Stage A wires every hook: persistence (disabled until a real document
 * identity exists), transport, library, page lifecycle, resume, search,
 * zoom, and the reader keyboard set. The audio element and the real
 * document/library APIs land in A.8; until then the transport wraps an
 * empty ref and the placeholder book above stands in for the document.
 */
export default function Reader() {
    const [pageNumber, setPageNumber] = useState(1);
    const [pageText, setPageText] = useState('');
    const [pageSource, setPageSource] = useState('text');
    const [audioPage, setAudioPage] = useState(null);
    const [query, setQuery] = useState('');
    const [lastQuery, setLastQuery] = useState('');
    // Real document identity arrives in A.8. A null id keeps the progress
    // autosave disabled, so the scaffold writes nothing to localStorage.
    const [documentId] = useState(null);
    const rootRef = useRef(null);
    const audioRef = useRef(null);

    const { bookmarks, toggle, isBookmarked } = useBookmarks({ initial: [] });
    const zoom = useReaderZoom({ initial: 1, canZoom: canAlwaysZoom });
    const transport = useReaderTransport(audioRef);
    const search = useReaderSearch({
        findInDocument: placeholderFindInDocument,
        currentPage: pageNumber,
        totalPages: PLACEHOLDER_TOTAL_PAGES,
    });
    const library = usePreparedLibrary({ onError: () => {} });

    const lifecycle = useReaderPageLifecycle({
        totalPages: PLACEHOLDER_TOTAL_PAGES,
        resolveContent: useCallback(async (page) => ({
            text: PLACEHOLDER_PAGE_TEXT(page),
            source: 'text',
        }), []),
        onContent: useCallback((text, source, ctx) => {
            setPageText(text);
            setPageSource(source);
            setPageNumber(ctx.page);
            // A "load" marks the page the reader would be narrating; the
            // resume dialog compares it against the browsed page.
            if (ctx.kind === 'load') setAudioPage(ctx.page);
        }, []),
        onBeforeLoad: useCallback(() => {
            transport.clearPlaylistTimeline();
            setPageText('');
        }, [transport]),
        onError: useCallback(() => {}, []),
    });

    const resume = usePageResume({
        currentPage: pageNumber,
        audioPage,
        hasAudio: audioPage != null,
        onResume: useCallback(() => {
            lifecycle.loadPage(audioPage);
        }, [lifecycle, audioPage]),
        onStartFresh: useCallback(() => {
            lifecycle.loadPage(pageNumber, { autoplay: true });
        }, [lifecycle, pageNumber]),
    });

    useReaderProgress({
        documentId,
        page: pageNumber,
        time: transport.currentTime,
        zoom: zoom.zoom,
        playbackRate: transport.playbackRate,
        bookmarks,
    });

    // Ctrl/Cmd+wheel zoom over the reading surface. Attached natively
    // (non-passive) because React's synthetic onWheel cannot
    // preventDefault.
    useEffect(() => {
        const el = rootRef.current;
        if (!el) return undefined;
        el.addEventListener('wheel', zoom.onWheel, { passive: false });
        return () => el.removeEventListener('wheel', zoom.onWheel);
    }, [zoom.onWheel]);

    // Jump to the page a successful search landed on. `result` only
    // changes on a newer submit, so the jump fires once per match.
    useEffect(() => {
        if (Number.isFinite(search.result)) lifecycle.browsePage(search.result);
    }, [search.result, lifecycle]);

    useKeyboardShortcuts({
        onToggleBookmark: () => toggle(pageNumber),
        onFind: () => document.getElementById('reader-search-input')?.focus(),
        onPrevPage: () => {
            if (pageNumber > 1) lifecycle.browsePage(pageNumber - 1);
        },
        onNextPage: () => {
            if (pageNumber < PLACEHOLDER_TOTAL_PAGES) lifecycle.browsePage(pageNumber + 1);
        },
        onFirstPage: () => lifecycle.browsePage(1),
        onLastPage: () => lifecycle.browsePage(PLACEHOLDER_TOTAL_PAGES),
        onToggleMute: () => {
            // Mute wiring lands in A.8 alongside the audio element.
        },
        onPlayPause: () => {
            // Play/pause lands in A.8 alongside useReaderTransport.
        },
        onShowShortcuts: () => {
            // The global `?` handler in App.jsx owns this; no-op here.
        },
    });

    const submitSearch = (event) => {
        event.preventDefault();
        const trimmed = query.trim();
        if (!trimmed) return;
        setLastQuery(trimmed);
        search.submit(trimmed);
    };

    let searchStatus = null;
    if (search.isSearching) {
        searchStatus = 'Searching…';
    } else if (search.error) {
        searchStatus = `Search failed: ${search.error.message}`;
    } else if (lastQuery) {
        searchStatus = Number.isFinite(search.result)
            ? `Found “${lastQuery}” on page ${search.result}.`
            : `No matches for “${lastQuery}”.`;
    }

    return (
        <div className="pdf-viewer-container" ref={rootRef} data-transport-state="idle">
            <div className="reader-toolbar-row">
                <button
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={() => toggle(pageNumber)}
                    aria-label={isBookmarked(pageNumber) ? `Remove bookmark from page ${pageNumber}` : `Bookmark page ${pageNumber}`}
                    aria-pressed={isBookmarked(pageNumber)}
                >
                    {isBookmarked(pageNumber) ? <BookmarkCheck size={16} aria-hidden="true" /> : <Bookmark size={16} aria-hidden="true" />}
                    {isBookmarked(pageNumber) ? 'Bookmarked' : 'Bookmark this page'}
                </button>
                <button
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={() => lifecycle.browsePage(pageNumber - 1)}
                    disabled={pageNumber <= 1}
                    aria-label="Previous page"
                >
                    Previous
                </button>
                <button
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={() => lifecycle.browsePage(pageNumber + 1)}
                    disabled={pageNumber >= PLACEHOLDER_TOTAL_PAGES}
                    aria-label="Next page"
                >
                    Next
                </button>
                <button
                    type="button"
                    className="btn primary btn-compact"
                    onClick={() => lifecycle.loadPage(pageNumber, { autoplay: true })}
                >
                    Read
                </button>
                <button
                    type="button"
                    className="icon-btn"
                    onClick={zoom.out}
                    disabled={zoom.zoom <= zoom.min}
                    aria-label="Zoom out"
                >
                    <ZoomOut size={16} aria-hidden="true" />
                </button>
                <span className="reader-zoom-pct" aria-live="polite">{Math.round(zoom.zoom * 100)}%</span>
                <button
                    type="button"
                    className="icon-btn"
                    onClick={zoom.in}
                    disabled={zoom.zoom >= zoom.max}
                    aria-label="Zoom in"
                >
                    <ZoomIn size={16} aria-hidden="true" />
                </button>
                <button
                    type="button"
                    className="btn text btn-compact"
                    onClick={zoom.fit}
                >
                    Fit
                </button>
                <form className="reader-search" onSubmit={submitSearch}>
                    <label htmlFor="reader-search-input" className="sr-only">Find in book</label>
                    <input
                        id="reader-search-input"
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Find in book"
                    />
                    <button
                        type="submit"
                        className="btn secondary btn-compact"
                        disabled={!query.trim() || search.isSearching}
                        aria-label="Search"
                    >
                        <Search size={14} aria-hidden="true" />
                    </button>
                </form>
            </div>
            {searchStatus && (
                <small className="reader-search-status" role="status">{searchStatus}</small>
            )}
            {resume.showChoice && (
                <div className="reader-resume-choice" role="dialog" aria-label="Resume or start fresh?">
                    <p>Resume narration on page {audioPage}, or start fresh on page {pageNumber}?</p>
                    <button type="button" className="btn secondary btn-compact" onClick={resume.resume}>Resume</button>
                    <button type="button" className="btn primary btn-compact" onClick={resume.startFresh}>Start fresh</button>
                    <button type="button" className="btn text btn-compact" onClick={resume.dismiss}>Dismiss</button>
                </div>
            )}
            {pageSource === 'pdf' ? (
                <PdfStage
                    file={null}
                    pageNumber={pageNumber}
                    displayZoom={zoom.displayZoom}
                />
            ) : (
                <TextStage
                    text={pageText}
                    pageNumber={pageNumber}
                    numPages={PLACEHOLDER_TOTAL_PAGES}
                    displayZoom={zoom.displayZoom}
                />
            )}
            <small className="reader-bookmark-count">
                {bookmarks.length === 0 ? 'No bookmarks yet.' : `Bookmarks: ${bookmarks.join(', ')}`}
            </small>
            <small className="reader-library-count">
                {library.isLoading ? 'Loading library…' : `Library: ${library.books.length} books`}
            </small>
        </div>
    );
}
