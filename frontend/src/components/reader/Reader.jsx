import { useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, FolderOpen, Search, ZoomIn, ZoomOut } from 'lucide-react';
import { useToast } from '../Toast';
import {
    getPreparedPage,
    importPreparedBook,
    preparedBookSource,
    savePreparedPage,
    updatePreparedProgress,
} from '../../utils/api';
import { libraryBookFile, sourceKindFromName } from '../../utils/bookFiles';
import { resolvePageContent } from '../../utils/pageContentResolver';
import { documentFingerprint, loadReadingProgress } from '../../utils/readingProgress';
import { usePdfDocument } from '../../hooks/usePdfDocument';
import { useBookmarks } from '../../hooks/reader/useBookmarks';
import { useKeyboardShortcuts } from '../../hooks/reader/useKeyboardShortcuts';
import { usePageResume } from '../../hooks/reader/usePageResume';
import { usePreparedLibrary } from '../../hooks/reader/usePreparedLibrary';
import { useReaderPageLifecycle } from '../../hooks/reader/useReaderPageLifecycle';
import { useReaderProgress } from '../../hooks/reader/useReaderProgress';
import { useReaderSearch } from '../../hooks/reader/useReaderSearch';
import { useReaderTransport } from '../../hooks/reader/useReaderTransport';
import { useReaderZoom } from '../../hooks/reader/useReaderZoom';
import { useServerPageText } from '../../hooks/reader/useServerPageText';
import PdfStage from './PdfStage';
import TextStage from './TextStage';

const FILE_ACCEPT = '.pdf,.epub,.txt,.md,.bookvoice,application/pdf,application/zip';

/**
 * Reader (new) — composition root for the migrated reader.
 *
 * Stage A.8.1 opens real books: files land in the prepared library
 * (`importPreparedBook`), PDFs render through `PdfStage` (react-pdf),
 * text books (.epub/.txt/.md) stream their pages from the server, and
 * reading progress is keyed by the document fingerprint so it survives
 * re-opens — locally through `useReaderProgress` and server-side for
 * library books. Text extraction and find-in-book reuse the production
 * `usePdfDocument` core; freshly extracted pages are written back to
 * the library so it stays authoritative.
 *
 * The TTS/audio port is the remaining A.8 work: the transport wraps an
 * empty ref, so play/pause, mute, seek, and true audio resume are
 * intentional no-ops until the narration pipeline lands.
 */
export default function Reader() {
    const toast = useToast();
    const [file, setFile] = useState(null);
    const [sourceKind, setSourceKind] = useState('pdf');
    const [documentId, setDocumentId] = useState(null);
    const [libraryBookId, setLibraryBookId] = useState(null);
    const [numPages, setNumPages] = useState(null);
    const [pageNumber, setPageNumber] = useState(1);
    const [pageText, setPageText] = useState('');
    const [audioPage, setAudioPage] = useState(null);
    const [query, setQuery] = useState('');
    const [lastQuery, setLastQuery] = useState('');
    const [pdfLoadError, setPdfLoadError] = useState(null);
    const [statusHint, setStatusHint] = useState('');

    // Refs mirror the values the async paths (content resolution, search,
    // shortcuts) read: a freshly activated book must resolve against its
    // new identity before the next React commit flushes state.
    const fileRef = useRef(null);
    const rootRef = useRef(null);
    const pageNumberRef = useRef(1);
    const numPagesRef = useRef(null);
    const libraryBookIdRef = useRef(null);
    const activeProfileIdRef = useRef(null);
    const isTextBookRef = useRef(false);
    const audioRef = useRef(null);
    const progressSaveFailedRef = useRef(false);

    const { bookmarks, toggle, set: setBookmarks, isBookmarked } = useBookmarks({ initial: [] });
    const zoom = useReaderZoom({ initial: 1 });
    const transport = useReaderTransport(audioRef);
    const { books, isLoading: libraryIsLoading, refresh, setBooks } = usePreparedLibrary({
        onError: useCallback((error) => {
            toast.error(error.message || 'Could not load the prepared-book library.');
        }, [toast]),
    });

    const pdfDocument = usePdfDocument({ file, fileRef, toast });
    const serverPages = useServerPageText({ totalPages: numPages });

    const resolveContent = useCallback(async (page) => {
        if (isTextBookRef.current) {
            const text = await serverPages.fetchPage(libraryBookIdRef.current, page);
            return { text, source: 'text' };
        }
        return resolvePageContent({
            bookId: libraryBookIdRef.current,
            profileId: activeProfileIdRef.current,
            page,
            getPreparedPage,
            preparePageText: (p) => pdfDocument.preparePageText(p),
        });
    }, [serverPages, pdfDocument]);

    const lifecycle = useReaderPageLifecycle({
        totalPages: numPages || 0,
        resolveContent,
        onContent: useCallback((text, source, ctx) => {
            setPageText(text);
            pageNumberRef.current = ctx.page;
            setPageNumber(ctx.page);
            // A "load" marks the page the reader will narrate; the resume
            // dialog compares it against the browsed page.
            if (ctx.kind === 'load') setAudioPage(ctx.page);
            // Persist freshly extracted PDF text so the library — not a
            // local cache — is authoritative on the next open. Text-book
            // pages already live on the server; 'prepared' came from it.
            if (libraryBookIdRef.current && source !== 'prepared' && source !== 'text') {
                savePreparedPage(
                    libraryBookIdRef.current,
                    ctx.page,
                    text,
                    numPagesRef.current || ctx.page,
                ).catch(() => { /* local reading still works without the write */ });
            }
        }, []),
        onBeforeLoad: useCallback(() => {
            transport.clearPlaylistTimeline();
            setPageText('');
        }, [transport]),
        onError: useCallback((error) => {
            toast.error(error.message || 'Could not open that page.');
        }, [toast]),
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

    // Server-side mirror of the reading position for library books, so
    // the library's continue-reading row stays current. Debounced;
    // failures toast once per open book.
    useEffect(() => {
        if (!libraryBookId || !file) return undefined;
        const timer = setTimeout(() => {
            updatePreparedProgress(libraryBookId, {
                page: pageNumber,
                time: transport.currentTime,
                bookmarks,
                updatedAt: Math.floor(Date.now() / 1000),
            }).then((progress) => {
                progressSaveFailedRef.current = false;
                setBooks((current) => current.map((book) => (
                    book.id === libraryBookId ? { ...book, progress } : book
                )));
            }).catch(() => {
                if (!progressSaveFailedRef.current) {
                    progressSaveFailedRef.current = true;
                    toast.error('Could not save prepared-book progress.');
                }
            });
        }, 3000);
        return () => clearTimeout(timer);
    }, [file, libraryBookId, pageNumber, bookmarks, transport.currentTime, setBooks, toast]);

    // Ctrl/Cmd+wheel zoom over the reading surface. Attached natively
    // (non-passive) because React's synthetic onWheel cannot
    // preventDefault.
    useEffect(() => {
        const el = rootRef.current;
        if (!el) return undefined;
        el.addEventListener('wheel', zoom.onWheel, { passive: false });
        return () => el.removeEventListener('wheel', zoom.onWheel);
    }, [zoom.onWheel]);

    const search = useReaderSearch({
        findInDocument: useCallback((q, startPage) => (
            isTextBookRef.current
                ? serverPages.findText(libraryBookIdRef.current, q, startPage)
                : pdfDocument.findTextInDocument(q, startPage)
        ), [serverPages, pdfDocument]),
        currentPage: pageNumber,
        totalPages: numPages || 0,
    });

    // Jump to the page a successful search landed on. `result` only
    // changes on a newer submit, so the jump fires once per match.
    useEffect(() => {
        if (Number.isFinite(search.result)) lifecycle.browsePage(search.result);
    }, [search.result, lifecycle]);

    useKeyboardShortcuts({
        isEnabled: () => Boolean(fileRef.current),
        onToggleBookmark: () => toggle(pageNumber),
        onFind: () => document.getElementById('reader-search-input')?.focus(),
        onPrevPage: () => {
            if (pageNumber > 1) lifecycle.browsePage(pageNumber - 1);
        },
        onNextPage: () => {
            if (!numPages || pageNumber < numPages) lifecycle.browsePage(pageNumber + 1);
        },
        onFirstPage: () => lifecycle.browsePage(1),
        onLastPage: () => {
            if (numPages) lifecycle.browsePage(numPages);
        },
        onToggleMute: () => {
            // Mute wiring lands with the A.8 audio element.
        },
        onPlayPause: () => {
            // Play/pause lands with the A.8 audio element.
        },
        onShowShortcuts: () => {
            // The global `?` handler in App.jsx owns this; no-op here.
        },
    });

    const activateBook = (f, book = null) => {
        if (!f) return;
        const nextSourceKind = book?.sourceKind || sourceKindFromName(f.name);
        const nextDocumentId = documentFingerprint(f);
        const progress = loadReadingProgress(nextDocumentId);
        const isTextBook = nextSourceKind !== 'pdf';

        pdfDocument.resetDocument();
        setPdfLoadError(null);
        fileRef.current = f;
        setFile(f);
        setSourceKind(nextSourceKind);
        isTextBookRef.current = isTextBook;
        setDocumentId(nextDocumentId);
        setBookmarks(progress.bookmarks);
        if (progress.playbackRate) transport.setRate(progress.playbackRate);
        libraryBookIdRef.current = book?.id || null;
        setLibraryBookId(book?.id || null);
        activeProfileIdRef.current = book?.activeProfileId || book?.profiles?.[0]?.id || null;
        progressSaveFailedRef.current = false;
        serverPages.clear();
        // Text books know their page count up front; a PDF learns it when
        // the Document reports onLoadSuccess, which also performs the
        // first content load.
        numPagesRef.current = isTextBook ? Number(book?.pageCount ?? book?.chapterCount) || null : null;
        setNumPages(numPagesRef.current);
        pageNumberRef.current = progress.page;
        setPageNumber(progress.page);
        setAudioPage(null);
        setPageText('');
        setQuery('');
        setLastQuery('');
        search.reset();
        zoom.set(progress.zoom);
        if (isTextBook) lifecycle.loadPage(progress.page, { autoplay: false });
    };

    const openLibraryBook = async (book) => {
        try {
            const kind = book.sourceKind || 'pdf';
            const source = kind === 'pdf' ? await preparedBookSource(book.id) : null;
            activateBook(libraryBookFile(book, source), book);
        } catch (error) {
            toast.error(error.message || 'Could not open the prepared book.');
        }
    };

    const handleFileChange = async (event) => {
        const selected = event.target.files[0];
        if (!selected) return;
        const isArchive = selected.name.toLowerCase().endsWith('.bookvoice');
        // Text books must land in the library before opening: their pages
        // are served from the server manifest, not read from the local file.
        const needsImportFirst = !isArchive && !/\.pdf$/i.test(selected.name);
        try {
            setStatusHint('Adding book to your library…');
            if (needsImportFirst) {
                const book = await importPreparedBook(selected);
                await refresh();
                activateBook(selected, book);
                return;
            }
            if (!isArchive) activateBook(selected, null);
            const book = await importPreparedBook(selected);
            await refresh();
            if (isArchive) {
                await openLibraryBook(book);
            } else {
                // The book renders from the local file; the library record
                // only supplies prepared pages and profiles.
                libraryBookIdRef.current = book.id;
                setLibraryBookId(book.id);
                activeProfileIdRef.current = book.activeProfileId || book.profiles?.[0]?.id || null;
            }
        } catch (error) {
            if (isArchive) toast.error(error.message || 'Could not open this book.');
            else toast.error('The book is open, but it could not be added to the prepared library.');
        } finally {
            setStatusHint('');
            event.target.value = '';
        }
    };

    const handleDocumentLoad = (pdf) => {
        setPdfLoadError(null);
        pdfDocument.adoptPdfDocument(pdf);
        numPagesRef.current = pdf.numPages;
        setNumPages(pdf.numPages);
        const restored = Math.max(1, Math.min(pdf.numPages, pageNumberRef.current));
        pageNumberRef.current = restored;
        setPageNumber(restored);
        lifecycle.loadPage(restored, { autoplay: false });
    };

    const handleDocumentError = (error) => {
        const msg = error?.message || String(error);
        setPdfLoadError(
            /password|encrypt/i.test(msg)
                ? 'This PDF is password-protected and cannot be opened.'
                : /fetch|network|load/i.test(msg)
                    ? 'The PDF could not be loaded. The file may be missing or the server unreachable.'
                    : `Failed to load PDF: ${msg}`
        );
        toast.error('Failed to open PDF');
    };

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

    if (!file) {
        return (
            <div className="pdf-viewer-container">
                <div className="reader-open">
                    <h2 className="reader-open-title">Open a book to start reading</h2>
                    <label className="btn primary" htmlFor="reader-upload">
                        <FolderOpen size={16} aria-hidden="true" />
                        Choose a book file
                    </label>
                    <input
                        id="reader-upload"
                        type="file"
                        className="file-input"
                        accept={FILE_ACCEPT}
                        onChange={handleFileChange}
                    />
                    <p className="reader-open-hint">
                        PDF, EPUB, and text files. Books you open are added to your library.
                    </p>
                    {books.length > 0 && (
                        <div className="reader-open-list" aria-label="Prepared books">
                            {books.map((book) => (
                                <button
                                    key={book.id}
                                    type="button"
                                    className="prepared-book-row"
                                    onClick={() => openLibraryBook(book)}
                                >
                                    <span className="prepared-book-row-heading">
                                        <span className="source-kind-badge">{book.sourceKind || 'pdf'}</span>
                                        <strong>{book.title || 'Prepared book'}</strong>
                                    </span>
                                    {Number(book.pageCount) > 0 && <span>{book.pageCount} pages</span>}
                                </button>
                            ))}
                        </div>
                    )}
                    {libraryIsLoading && <small className="reader-page-status" role="status">Loading library…</small>}
                    {statusHint && <small className="reader-page-status" role="status">{statusHint}</small>}
                </div>
            </div>
        );
    }

    const isTextBook = sourceKind !== 'pdf';

    return (
        <div className="pdf-viewer-container" ref={rootRef} data-transport-state="idle" data-source-kind={sourceKind}>
            {statusHint && <small className="reader-page-status" role="status">{statusHint}</small>}
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
                <span className="reader-page-status" aria-live="polite">
                    Page {pageNumber}{numPages ? ` of ${numPages}` : ''}
                </span>
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
                    disabled={Boolean(numPages) && pageNumber >= numPages}
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
            {pdfLoadError && (
                <div className="reader-pdf-error" role="alert">
                    <p>{pdfLoadError}</p>
                    <button
                        type="button"
                        className="btn secondary btn-compact"
                        onClick={() => setPdfLoadError(null)}
                    >
                        Try again
                    </button>
                </div>
            )}
            {resume.showChoice && (
                <div className="reader-resume-choice" role="dialog" aria-label="Resume or start fresh?">
                    <p>Resume narration on page {audioPage}, or start fresh on page {pageNumber}?</p>
                    <button type="button" className="btn secondary btn-compact" onClick={resume.resume}>Resume</button>
                    <button type="button" className="btn primary btn-compact" onClick={resume.startFresh}>Start fresh</button>
                    <button type="button" className="btn text btn-compact" onClick={resume.dismiss}>Dismiss</button>
                </div>
            )}
            {!pdfLoadError && (isTextBook ? (
                <TextStage
                    text={pageText}
                    pageNumber={pageNumber}
                    numPages={numPages}
                    displayZoom={zoom.displayZoom}
                />
            ) : (
                <PdfStage
                    file={file}
                    pageNumber={pageNumber}
                    displayZoom={zoom.displayZoom}
                    onDocumentLoad={handleDocumentLoad}
                    onDocumentError={handleDocumentError}
                />
            ))}
            <small className="reader-bookmark-count">
                {bookmarks.length === 0 ? 'No bookmarks yet.' : `Bookmarks: ${bookmarks.join(', ')}`}
            </small>
        </div>
    );
}
