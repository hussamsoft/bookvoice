import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Bookmark,
    BookmarkCheck,
    ChevronDown,
    ChevronUp,
    Download,
    Loader2,
    LocateFixed,
    Maximize2,
    Search,
    ZoomIn,
    ZoomOut,
} from 'lucide-react';

const ZOOM_LIMITS = { min: 0.7, max: 2.6, step: 0.15 };

/**
 * Reader toolbar, clustered into labeled move · view · track · find groups
 * (visually-hidden labels via role="group" + aria-label, subtle hairline
 * separators between groups). Secondary actions — export and the bookmark
 * jump list — collapse into a focus-trapped "More" popover so the primary
 * row fits without wrapping on typical desktop widths.
 */
export default function ReaderToolbar({
    pageNumber,
    numPages,
    pageJumpInput,
    onPageJumpInput,
    onPageJumpSubmit,
    onGoToPage,
    audioPage,
    onReturnToNarrated,
    zoom,
    onZoom,
    followNarration,
    onFollowNarration,
    searchQuery,
    onSearchQuery,
    onSearchSubmit,
    isSearching,
    bookmarks,
    onToggleBookmark,
    isExporting,
    onExportThroughCurrentPage,
    isTextBook = false,
}) {
    const [moreOpen, setMoreOpen] = useState(false);
    const moreRootRef = useRef(null);
    const moreTriggerRef = useRef(null);

    const closeMore = useCallback(() => {
        setMoreOpen(false);
        moreTriggerRef.current?.focus();
    }, []);

    useEffect(() => {
        if (!moreOpen) return undefined;
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                closeMore();
                return;
            }
            if (event.key !== 'Tab' || !moreRootRef.current) return;
            const focusable = moreRootRef.current.querySelectorAll(
                'button:not(:disabled), select:not(:disabled), input:not([type="hidden"]), a[href]',
            );
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if ((event.shiftKey && document.activeElement === first)
                || (!event.shiftKey && document.activeElement === last)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            }
        };
        const onMouseDown = (event) => {
            if (moreRootRef.current && !moreRootRef.current.contains(event.target)) {
                closeMore();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('mousedown', onMouseDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('mousedown', onMouseDown);
        };
    }, [moreOpen, closeMore]);


    return (
        <div className="reader-navigation" role="toolbar" aria-label="Reader navigation">
            <div className="reader-nav-group" role="group" aria-label="Move between pages">
                <button
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={() => onGoToPage(pageNumber - 1)}
                    disabled={pageNumber <= 1}
                    aria-label="Previous page"
                >
                    <ChevronUp size={15} aria-hidden="true" /> Previous
                </button>
                <form className="page-jump" onSubmit={onPageJumpSubmit}>
                    <label htmlFor="reader-page-input">Page</label>
                    <input
                        id="reader-page-input"
                        type="number"
                        min={1}
                        max={numPages || 1}
                        value={pageJumpInput}
                        onChange={(event) => onPageJumpInput(event.target.value)}
                        onBlur={onPageJumpSubmit}
                        aria-label={`Go to page between 1 and ${numPages || 1}`}
                    />
                    <span>/ {numPages || '—'}</span>
                </form>
                <button
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={() => onGoToPage(pageNumber + 1)}
                    disabled={pageNumber >= numPages}
                    aria-label="Next page"
                >
                    Next <ChevronDown size={15} aria-hidden="true" />
                </button>
                {audioPage && audioPage !== pageNumber ? (
                    <button
                        type="button"
                        className="btn primary btn-compact"
                        onClick={onReturnToNarrated}
                        aria-label={`Return to narrated page ${audioPage}`}
                        title={`Return to narrated page ${audioPage}`}
                    >
                        <LocateFixed size={15} aria-hidden="true" /> Page {audioPage}
                    </button>
                ) : null}
            </div>
            {!isTextBook ? (
                <div className="reader-nav-group" role="group" aria-label="View">
                    <div className="zoom-controls" title="Zoom with Ctrl+mouse wheel or these controls">
                        <button
                            type="button"
                            className="btn secondary btn-compact"
                            onClick={() => onZoom(Math.max(ZOOM_LIMITS.min, zoom - ZOOM_LIMITS.step))}
                            aria-label="Zoom out"
                        >
                            <ZoomOut size={15} aria-hidden="true" />
                        </button>
                        <span
                            className="zoom-label"
                            role="status"
                            aria-label={`Zoom ${Math.round(zoom * 100)} percent`}
                        >
                            {Math.round(zoom * 100)}%
                        </span>
                        <button
                            type="button"
                            className="btn secondary btn-compact"
                            onClick={() => onZoom(Math.min(ZOOM_LIMITS.max, zoom + ZOOM_LIMITS.step))}
                            aria-label="Zoom in"
                        >
                            <ZoomIn size={15} aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            className="btn secondary btn-compact"
                            onClick={() => onZoom(1)}
                            aria-label="Fit PDF to reading area"
                        >
                            <Maximize2 size={15} aria-hidden="true" />
                        </button>
                    </div>
                </div>
            ) : null}
            <div className="reader-nav-group" role="group" aria-label="Track narration">
                <label className="reader-follow">
                    <input
                        type="checkbox"
                        checked={followNarration}
                        onChange={(event) => onFollowNarration(event.target.checked)}
                    />
                    Follow narration
                </label>
                <button
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={() => onToggleBookmark()}
                    aria-label={bookmarks.includes(pageNumber) ? `Remove bookmark from page ${pageNumber}` : `Bookmark page ${pageNumber}`}
                    aria-pressed={bookmarks.includes(pageNumber)}
                >
                    {bookmarks.includes(pageNumber) ? (
                        <BookmarkCheck size={15} aria-hidden="true" />
                    ) : (
                        <Bookmark size={15} aria-hidden="true" />
                    )}
                    {bookmarks.includes(pageNumber) ? `Bookmarked ${pageNumber}` : 'Bookmark'}
                </button>
            </div>
            <div className="reader-nav-group" role="group" aria-label="Find in book">
                <form className="page-search" onSubmit={onSearchSubmit}>
                    <Search size={14} aria-hidden="true" />
                    <input
                        type="search"
                        value={searchQuery}
                        onChange={(event) => onSearchQuery(event.target.value)}
                        placeholder="Find in book"
                        aria-label="Find text in book"
                    />
                    <button className="btn secondary btn-compact" disabled={!searchQuery.trim() || isSearching}>
                        {isSearching ? <Loader2 className="spinner" size={14} aria-hidden="true" /> : 'Find'}
                    </button>
                </form>
            </div>
            <div className="reader-nav-more" ref={moreRootRef}>
                <button
                    ref={moreTriggerRef}
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={() => setMoreOpen((open) => !open)}
                    aria-expanded={moreOpen}
                    aria-haspopup="true"
                >
                    More <ChevronDown size={15} aria-hidden="true" />
                </button>
                {moreOpen ? (
                    <div className="reader-nav-menu" aria-label="More reader actions">
                        {pageNumber > 1 ? (
                            <button
                                type="button"
                                className="btn secondary btn-compact"
                                onClick={onExportThroughCurrentPage}
                                disabled={isExporting}
                                title={`Export cached audio for pages 1 through ${pageNumber}`}
                            >
                                {isExporting ? <Loader2 className="spinner" size={15} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
                                Export 1–{pageNumber}
                            </button>
                        ) : null}
                        {bookmarks.length ? (
                            <select
                                className="bookmark-jump"
                                aria-label="Go to bookmark"
                                value=""
                                onChange={(event) => {
                                    if (event.target.value) {
                                        onGoToPage(Number(event.target.value));
                                        setMoreOpen(false);
                                        moreTriggerRef.current?.focus();
                                    }
                                }}
                            >
                                <option value="">Bookmarks ({bookmarks.length})</option>
                                {bookmarks.map((page) => (
                                    <option key={page} value={page}>
                                        Page {page}
                                    </option>
                                ))}
                            </select>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
