import React from 'react';
import { Loader2 } from 'lucide-react';
import {
    Bookmark,
    BookmarkCheck,
    ChevronDown,
    ChevronUp,
    Download,
    LocateFixed,
    Maximize2,
    Search,
    SlidersHorizontal,
    ZoomIn,
    ZoomOut,
} from 'lucide-react';

export const ZOOM_LIMITS = { min: 0.7, max: 2.6, step: 0.15 };

/**
 * Reader toolbar: page movement, zoom, follow toggle, export, search,
 * bookmarks, and the reading-options toggle.
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
    showReadingOptions,
    onToggleReadingOptions,
}) {
    return (
        <div className="reader-navigation" role="toolbar" aria-label="Reader navigation">
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
                >
                    <LocateFixed size={15} aria-hidden="true" /> Return to narrated page {audioPage}
                </button>
            ) : null}
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
            <label className="reader-follow">
                <input
                    type="checkbox"
                    checked={followNarration}
                    onChange={(event) => onFollowNarration(event.target.checked)}
                />
                Follow narration
            </label>
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
            {bookmarks.length ? (
                <select
                    className="bookmark-jump"
                    aria-label="Go to bookmark"
                    value=""
                    onChange={(event) => {
                        if (event.target.value) onGoToPage(Number(event.target.value));
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
            <button
                type="button"
                className="btn secondary btn-compact"
                onClick={onToggleReadingOptions}
                aria-expanded={showReadingOptions}
                aria-label="Reading options"
            >
                <SlidersHorizontal size={15} aria-hidden="true" /> Reading options
            </button>
        </div>
    );
}
