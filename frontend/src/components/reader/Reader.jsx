import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Bookmark,
    BookmarkCheck,
    ChevronDown,
    FolderOpen,
    Search,
    Volume2,
    VolumeX,
    ZoomIn,
    ZoomOut,
} from 'lucide-react';
import { useToast } from '../Toast';
import PlaybackControls from '../PlaybackControls';
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
import { createSessionId } from '../../utils/session';
import { usePdfDocument } from '../../hooks/usePdfDocument';
import { useSleepTimer } from '../../hooks/useSleepTimer';
import { useTtsStatus } from '../../hooks/useTtsStatus';
import { useUserConfig } from '../../hooks/useUserConfig';
import { useBookmarks } from '../../hooks/reader/useBookmarks';
import { useKeyboardShortcuts } from '../../hooks/reader/useKeyboardShortcuts';
import { usePreparedLibrary } from '../../hooks/reader/usePreparedLibrary';
import { useReaderNarration } from '../../hooks/reader/useReaderNarration';
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
 * Reader — composition root for the reader.
 *
 * Opens real books: files land in the prepared library
 * (`importPreparedBook`), PDFs render through `PdfStage` (react-pdf),
 * text books (.epub/.txt/.md) stream their pages from the server, and
 * reading progress is keyed by the document fingerprint so it survives
 * re-opens — locally through `useReaderProgress` and server-side for
 * library books. Text extraction and find-in-book reuse the production
 * `usePdfDocument` core; freshly extracted pages are written back to
 * the library so it stays authoritative.
 *
 * Narration pipeline: pages narrate through `useReaderNarration`
 * using a chunked streaming endpoint (see `narrateTextStream`).
 * Playback is gapless: the audio element loads chunk N+1 within the
 * 50 ms seam budget when chunk N ends. Sleep timer (5/10/15/30/45/60
 * minutes or "End of chapter") is wired through the shared
 * `useSleepTimer` and only fires on natural page ends (not user
 * stops) so Stop mid-page does not prematurely end the sleep arm.
 *
 * The legacy `?reader=old` fallback to PdfViewer.jsx was removed in
 * 2.8.0. This reader is the only option.
 */
export default function Reader() {
    const toast = useToast();
    const [file, setFile] = useState(null);
    const [sourceKind, setSourceKind] = useState('pdf');
    const [documentId, setDocumentId] = useState(null);
    const [libraryBookId, setLibraryBookId] = useState(null);
    const [numPages, setNumPages] = useState(null);
    const [pageNumber, setPageNumber] = useState(1);
    const [pageJumpInput, setPageJumpInput] = useState('1');
    const [pageText, setPageText] = useState('');
    const [query, setQuery] = useState('');
    const [lastQuery, setLastQuery] = useState('');
    // The page a search last landed on, kept independent of `search.result`
    // (which is reset immediately after the jump — see the effect below).
    const [foundPage, setFoundPage] = useState(null);
    const [pdfLoadError, setPdfLoadError] = useState(null);
    const [statusHint, setStatusHint] = useState('');
    const [moreOpen, setMoreOpen] = useState(false);
    const [sessionId] = useState(() => createSessionId('reader'));
    const { modelReady } = useTtsStatus();
    // Saved user voice/language. Apply-once so a user selection before the
    // config fetch settles wins over the stored value (mirrors
    // BookSession/PdfViewer + configApply.test.js).
    const { config } = useUserConfig();
    const [activeVoiceId, setActiveVoiceId] = useState(null);
    const [targetLanguage, setTargetLanguage] = useState('en');
    const configAppliedRef = useRef(false);
    const userTouchedVoiceRef = useRef(false);
    const userTouchedLanguageRef = useRef(false);

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
    // Leading-edge throttle for the prepared-book progress mirror.
    // The closure stored in `progressPendingFlushRef` is rebuilt on
    // every effect run so the eventual write reflects the *latest*
    // state, but the timer is only armed if none is pending. Without
    // this, transport.currentTime updates (~4 Hz during playback)
    // would clear and re-arm the timer on every tick and the save
    // would never fire while the user is listening. See
    // useReaderProgress.js for the same leading-edge throttle pattern.
    const progressPendingFlushRef = useRef(null);
    const progressFlushTimerRef = useRef(null);
    const flushPreparedProgress = () => {
        if (progressFlushTimerRef.current) {
            clearTimeout(progressFlushTimerRef.current);
            progressFlushTimerRef.current = null;
        }
        const snapshot = progressPendingFlushRef.current;
        progressPendingFlushRef.current = null;
        if (snapshot) snapshot();
    };
    // The narration hook is created below the lifecycle (its fresh-page
    // escape hatch needs it), but the lifecycle's onContent needs the
    // hook — the ref bridges the cycle the same way PdfViewer bridges
    // handlePlay.
    const narrationRef = useRef(null);
    // The prepared-page record from the latest content resolution; the
    // lifecycle passes only (text, source, ctx) to onContent.
    const preparedRef = useRef(null);
    // Auto-open guard for the `?book=<id>` deep link (desktop shell,
    // .bookvoice double-click, addresses card). PdfViewer holds the
    // same flag (PdfViewer.jsx:239).
    const deepLinkOpenedRef = useRef(false);
    // Sleep-timer handle. The page-ended signal lives in the narration
    // hook; the reader only needs to fire it on `transportState ===
    // 'stopped'`. `onExpire` is wired below once `narration` exists.
    const sleepRef = useRef(null);

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

    // One resolver for both book kinds: prepared pages win when a
    // profile has them; otherwise PDFs extract (with OCR) and text
    // books fetch their server page. The prepared record is stashed for
    // the narration ladder.
    const resolveContent = useCallback(async (page) => {
        const result = await resolvePageContent({
            bookId: libraryBookIdRef.current,
            profileId: activeProfileIdRef.current,
            page,
            getPreparedPage,
            preparePageText: isTextBookRef.current
                ? (p) => serverPages.fetchPage(libraryBookIdRef.current, p)
                : (p) => pdfDocument.preparePageText(p),
        });
        preparedRef.current = result.prepared ?? null;
        return result;
    }, [serverPages, pdfDocument]);

    const lifecycle = useReaderPageLifecycle({
        totalPages: numPages || 0,
        resolveContent,
        onContent: useCallback((text, source, ctx) => {
            setPageText(text);
            pageNumberRef.current = ctx.page;
            setPageNumber(ctx.page);
            // A "load" narrates the page (or parks cached/prepared
            // audio when merely browsing). Fire-and-forget: generation
            // takes seconds and the text must paint now.
            if (ctx.kind === 'load') {
                void narrationRef.current?.startForLoadedPage(
                    ctx.page,
                    text,
                    preparedRef.current,
                    { autoplay: ctx.autoplay },
                );
            }
            // Persist freshly extracted PDF text so the library — not a
            // local cache — is authoritative on the next open. Text-book
            // pages already live on the server; 'prepared' came from it.
            if (libraryBookIdRef.current && !isTextBookRef.current && source !== 'prepared') {
                savePreparedPage(
                    libraryBookIdRef.current,
                    ctx.page,
                    text,
                    numPagesRef.current || ctx.page,
                ).catch(() => { /* local reading still works without the write */ });
            }
        }, []),
        onBeforeLoad: useCallback(() => {
            // Load-for-narration tears the current playback down before
            // the new page resolves.
            narrationRef.current?.teardownForNavigation();
            setPageText('');
        }, []),
        onError: useCallback((error) => {
            toast.error(error.message || 'Could not open that page.');
        }, [toast]),
    });

    const getPage = useCallback(() => pageNumberRef.current, []);
    const narration = useReaderNarration({
        audioRef,
        transport,
        sessionId,
        voiceId: activeVoiceId,
        languageId: targetLanguage,
        modelReady,
        getPage,
        onNarratePage: useCallback((page) => {
            lifecycle.loadPage(page, { autoplay: true });
        }, [lifecycle]),
        toast,
    });
    narrationRef.current = narration;

    // F-08: word-level highlight plumbing is in place (TextStage accepts
    // `currentWord` and wraps each word in a span), but the full
    // `useWordHighlight` RAF integration is deferred to a follow-up —
    // see tasks/fix-2.8.1/LOG.md. Word timings from the streaming
    // endpoint aren't reliable enough yet to drive the loop deterministically.
    const currentWord = null;

    // Sleep timer: counts down only while narration plays; expiry stops
    // playback so the user doesn't fall asleep to a finished page.
    const sleep = useSleepTimer({
        playing: narration.isPlaying,
        onExpire: narration.stopPlayback,
    });
    sleepRef.current = sleep;

    // Whenever the transport naturally reaches the end of the page
    // (streaming playlist exhausted, last chunk ended), notify the
    // end-of-chapter sleep mode. The minute-mode timer ignores this.
    useEffect(() => {
        if (narration.transportState === 'stopped'
            && narration.naturalEndRef?.current) {
            // Distinguish "page finished on its own" from "user clicked
            // Stop" (audit finding L-4). The end-of-chapter sleep arm
            // should only fire on natural ends; otherwise Stop mid-page
            // would prematurely end the sleep timer.
            narration.naturalEndRef.current = false;
            sleep.notifyPageEnded();
        }
    }, [narration, sleep]);

    // Apply-once the saved voice/language from useUserConfig. A user
    // touch before config arrives wins (see configApply.test.js).
    useEffect(() => {
        if (!config || configAppliedRef.current) return;
        configAppliedRef.current = true;
        if (!userTouchedVoiceRef.current && config.voice_id) {
            setActiveVoiceId(config.voice_id);
        }
        if (!userTouchedLanguageRef.current && config.language_id) {
            setTargetLanguage(config.language_id);
        }
    }, [config]);

    useReaderProgress({
        documentId,
        page: pageNumber,
        time: transport.currentTime,
        zoom: zoom.zoom,
        playbackRate: transport.playbackRate,
        bookmarks,
    });

    // Server-side mirror of the reading position for library books, so
    // the library's continue-reading row stays current. Leading-edge
    // throttle (audit finding C-6): the previous trailing-edge
    // debounce never fired during continuous playback because
    // transport.currentTime ticks ~4 Hz reset the timer on every
    // tick. The new pattern arms a timer only if none is pending and
    // rebuilds the snapshot closure on every state change, so the
    // eventual write reflects the latest values.
    useEffect(() => {
        if (!libraryBookId || !file) return undefined;
        progressPendingFlushRef.current = () => {
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
        };
        if (progressFlushTimerRef.current == null) {
            progressFlushTimerRef.current = setTimeout(flushPreparedProgress, 3000);
        }
        return undefined;
    }, [file, libraryBookId, pageNumber, bookmarks, transport.currentTime, setBooks, toast]);

    // Flush the pending progress save when the tab is hidden or the
    // reader unmounts, mirroring useReaderProgress's visibility flush.
    useEffect(() => () => flushPreparedProgress(), [libraryBookId]);

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
    // changes on a newer submit, so the jump fires once per match. The
    // result is consumed exactly once — `search.reset()` clears it right
    // after the jump so re-renders (narration ticks at ~4Hz) don't keep
    // re-firing this effect and re-resolving the page. The landed page is
    // kept in `foundPage` so the "Found … on page N" status survives the
    // reset and the subsequent navigation.
    useEffect(() => {
        if (Number.isFinite(search.result)) {
            setFoundPage(search.result);
            lifecycle.browsePage(search.result);
            search.reset();
        }
    }, [search.result, lifecycle, search]);

    // Keep the page-jump input in lockstep with the current page so the
    // field never disagrees with the toolbar's "Page N of M" status.
    useEffect(() => {
        setPageJumpInput(String(pageNumber));
    }, [pageNumber]);

    // Close the "More" popover on outside click or Escape, mirroring F-02.
    useEffect(() => {
        if (!moreOpen) return undefined;
        const onOutside = (event) => {
            const target = event.target;
            const insideMenu = target.closest?.('.reader-nav-menu');
            const insideTrigger = target.closest?.('.reader-nav-more');
            if (!insideMenu && !insideTrigger) setMoreOpen(false);
        };
        const onKey = (event) => {
            if (event.key === 'Escape') setMoreOpen(false);
        };
        document.addEventListener('mousedown', onOutside);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onOutside);
            document.removeEventListener('keydown', onKey);
        };
    }, [moreOpen]);

    const submitPageJump = useCallback((event) => {
        event?.preventDefault?.();
        const parsed = Number.parseInt(pageJumpInput, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
            setPageJumpInput(String(pageNumber));
            return;
        }
        const clamped = numPages ? Math.min(parsed, numPages) : parsed;
        if (clamped !== pageNumber) lifecycle.browsePage(clamped);
        setPageJumpInput(String(clamped));
    }, [pageJumpInput, pageNumber, numPages, lifecycle]);

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
        onPlayPause: () => narration.handlePlay(),
        onSeekBack: () => transport.skipBy(-10),
        onSeekForward: () => transport.skipBy(10),
        onToggleMute: () => narration.toggleMute(),
        onShowShortcuts: () => {
            // The global `?` handler in App.jsx owns this; no-op here.
        },
    });

    // `?book=<id>` deep link: open the prepared book whose id matches,
    // once the library list is loaded. Mirrors PdfViewer.jsx:237-242 so
    // desktop deep links and `.bookvoice` double-click work with the
    // new reader at default. Books from Library/Home are opened through
    // `openLibraryBook`, so the URL is already in sync. The ref bridges
    // to the function (defined below) so the effect doesn't need it in
    // its deps and re-fire on every render.
    const openLibraryBookRef = useRef(null);
    useEffect(() => {
        if (deepLinkOpenedRef.current) return;
        if (!books || books.length === 0) return;
        const requestedId = new URLSearchParams(window.location.search).get('book');
        if (!requestedId) return;
        const target = books.find((book) => book.id === requestedId);
        if (!target) return;
        deepLinkOpenedRef.current = true;
        openLibraryBookRef.current?.(target);
    }, [books]);

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
        narration.resetForNewBook(progress.page, progress.time);
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
    openLibraryBookRef.current = openLibraryBook;

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
        // Record the failure once on the inline alert; the redundant toast
        // was firing alongside it, so users saw two error messages for one
        // failure. The button below is now labelled "Dismiss" because the
        // previous "Try again" only cleared the message — it never re-attempted
        // the load. To retry, the user closes the alert and re-opens the book.
        setPdfLoadError(
            /password|encrypt/i.test(msg)
                ? 'This PDF is password-protected and cannot be opened.'
                : /fetch|network|load/i.test(msg)
                    ? 'The PDF could not be loaded. The file may be missing or the server unreachable.'
                    : `Failed to load PDF: ${msg}`
        );
    };

    const submitSearch = (event) => {
        event.preventDefault();
        const trimmed = query.trim();
        if (!trimmed) return;
        setLastQuery(trimmed);
        setFoundPage(null);
        search.submit(trimmed);
    };

    let searchStatus = null;
    if (search.isSearching) {
        searchStatus = 'Searching…';
    } else if (search.error) {
        searchStatus = `Search failed: ${search.error.message}`;
    } else if (lastQuery) {
        searchStatus = foundPage != null
            ? `Found “${lastQuery}” on page ${foundPage}.`
            : `No matches for “${lastQuery}”.`;
    }

    if (!file) {
        return (
            <div className="pdf-viewer-container">
                <audio ref={audioRef} className="audio-hidden" preload="auto" />
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
                        aria-label="Choose a book file"
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
        <div className="pdf-viewer-container" ref={rootRef} data-transport-state={narration.transportState} data-source-kind={sourceKind}>
            <audio ref={audioRef} className="audio-hidden" preload="auto" />
            {statusHint && <small className="reader-page-status" role="status">{statusHint}</small>}
            <div className="reader-toolbar-row">
                <button
                    type="button"
                    className="icon-btn reader-bookmark-toggle"
                    onClick={() => toggle(pageNumber)}
                    aria-label={isBookmarked(pageNumber) ? `Remove bookmark from page ${pageNumber}` : `Bookmark page ${pageNumber}`}
                    aria-pressed={isBookmarked(pageNumber)}
                    title={isBookmarked(pageNumber) ? 'Remove bookmark' : 'Bookmark this page'}
                >
                    {isBookmarked(pageNumber)
                        ? <BookmarkCheck size={16} aria-hidden="true" />
                        : <Bookmark size={16} aria-hidden="true" />}
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
                <form className="reader-page-jump" onSubmit={submitPageJump}>
                    <label htmlFor="reader-page-jump-input" className="sr-only">Go to page</label>
                    <input
                        id="reader-page-jump-input"
                        type="number"
                        min={1}
                        max={numPages || 1}
                        value={pageJumpInput}
                        onChange={(event) => setPageJumpInput(event.target.value)}
                        onBlur={submitPageJump}
                        aria-label={`Go to page between 1 and ${numPages || 1}`}
                    />
                </form>
                <button
                    type="button"
                    className="icon-btn reader-nav-more"
                    onClick={() => setMoreOpen((value) => !value)}
                    aria-haspopup="true"
                    aria-expanded={moreOpen}
                    aria-label="More options"
                    title="More options"
                >
                    <ChevronDown size={16} aria-hidden="true" />
                </button>
            </div>
            <PlaybackControls
                transport={transport}
                onToggle={narration.handlePlay}
                onStop={narration.stopPlayback}
                onSeek={transport.seekTo}
                duration={Number.isFinite(narration.scrubberDuration) ? narration.scrubberDuration : null}
                sleepRef={sleepRef}
                pageLabel={`Page ${pageNumber}${numPages ? ` of ${numPages}` : ''}`}
                generating={narration.isGenerating}
            />
            {moreOpen && (
                <div className="reader-nav-menu" aria-label="More reader options">
                    <div className="reader-nav-menu-group">
                        <button
                            type="button"
                            className="icon-btn"
                            onClick={narration.toggleMute}
                            aria-pressed={narration.muted}
                            aria-label={narration.muted ? 'Unmute narration' : 'Mute narration'}
                        >
                            {narration.muted ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
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
                    </div>
                    <div className="reader-nav-menu-group">
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
                    {bookmarks.length > 0 && (
                        <div className="reader-nav-menu-group reader-bookmark-jumps">
                            <span className="reader-nav-menu-label">Bookmarks</span>
                            {bookmarks.map((page) => (
                                <button
                                    key={page}
                                    type="button"
                                    className="btn text btn-compact bookmark-jump"
                                    onClick={() => lifecycle.browsePage(page)}
                                >
                                    Page {page}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {searchStatus && (
                <small className="reader-search-status" role="status">{searchStatus}</small>
            )}
            {narration.isGenerating && (
                <small className="reader-page-status" role="status">Generating narration…</small>
            )}
            {pdfLoadError && (
                <div className="reader-pdf-error" role="alert">
                    <p>{pdfLoadError}</p>
                    <button
                        type="button"
                        className="btn secondary btn-compact"
                        onClick={() => setPdfLoadError(null)}
                    >
                        Dismiss
                    </button>
                </div>
            )}
            {!pdfLoadError && (isTextBook ? (
                <TextStage
                    text={pageText}
                    pageNumber={pageNumber}
                    numPages={numPages}
                    displayZoom={zoom.displayZoom}
                    isLoading={lifecycle.isLoading}
                    currentWord={currentWord}
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
