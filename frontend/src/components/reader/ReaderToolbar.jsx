import React from 'react';
import {
    Bookmark,
    BookmarkCheck,
    ChevronDown,
    ChevronUp,
    Download,
    Loader2,
    Maximize2,
    MoreVertical,
    Pause,
    Play,
    Search,
    ZoomIn,
    ZoomOut,
} from 'lucide-react';
import { useReaderToolbar } from '../../hooks/useReaderToolbar';

const ZOOM_LIMITS = { min: 0.7, max: 2.6, step: 0.15 };

/**
 * Reader toolbar, two-tier structure:
 *  - Tier 1 (always visible, single row): page navigation (prev / page X of N /
 *    zoom-fit) + Play/Pause (the ONE primary action).
 *  - Tier 2 (overflow "…" popout): search, follow-narration, bookmark, export,
 *    bookmark-jump.
 */
export default function ReaderToolbar({
    pageNumber,
    numPages,
    pageJumpInput,
    onPageJumpInput,
    onPageJumpSubmit,
    onGoToPage,
    onTogglePlay,
    isPlaying,
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
}) {
    const {
        moreOpen,
        setMoreOpen,
        moreRootRef,
        moreTriggerRef,
        closeMore,
    } = useReaderToolbar();

    return (
        <div className="reader-navigation" role="toolbar" aria-label="Reader navigation">
            {/* Tier 1: Primary row (always visible, single line) */}
            <div className="reader-nav-primary">
                <button
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={() => onGoToPage(pageNumber - 1)}
                    disabled={pageNumber <= 1}
                    aria-label="Previous page"
                >
                    <ChevronUp size={15} aria-hidden="true" />
                    <span className="nav-btn-label">Prev</span>
                </button>
                <form className="page-jump" onSubmit={onPageJumpSubmit}>
                    <label htmlFor="reader-page-input" className="sr-only">Page</label>
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
                    <span className="page-jump-total">/ {numPages || '—'}</span>
                </form>
                <button
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={() => onGoToPage(pageNumber + 1)}
                    disabled={pageNumber >= numPages}
                    aria-label="Next page"
                >
                    <span className="nav-btn-label">Next</span>
                    <ChevronDown size={15} aria-hidden="true" />
                </button>
                <button
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={() => onZoom(Math.max(ZOOM_LIMITS.min, +(zoom - ZOOM_LIMITS.step).toFixed(2)))}
                    disabled={zoom <= ZOOM_LIMITS.min}
                    aria-label="Zoom out"
                >
                    <ZoomOut size={15} aria-hidden="true" />
                </button>
                <span className="reader-zoom-pct" aria-live="polite">{Math.round(zoom * 100)}%</span>
                <button
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={() => onZoom(Math.min(ZOOM_LIMITS.max, +(zoom + ZOOM_LIMITS.step).toFixed(2)))}
                    disabled={zoom >= ZOOM_LIMITS.max}
                    aria-label="Zoom in"
                >
                    <ZoomIn size={15} aria-hidden="true" />
                </button>
                <button
                    className="btn secondary btn-compact"
                    onClick={() => onZoom(1)}
                    aria-label="Fit PDF to reading area"
                >
                    <Maximize2 size={15} aria-hidden="true" />
                    <span className="nav-btn-label">Fit</span>
                </button>
                <label className="reader-follow reader-follow-inline">
                    <input
                        type="checkbox"
                        checked={followNarration}
                        onChange={(event) => onFollowNarration(event.target.checked)}
                    />
                    <span>Follow narration</span>
                </label>
                <button
                    type="button"
                    className={`btn primary transport-play ${isPlaying ? 'is-playing' : ''}`}
                    onClick={onTogglePlay}
                    aria-label={isPlaying ? 'Pause narration' : 'Play narration'}
                    title={isPlaying ? 'Pause narration' : 'Play narration'}
                >
                    {isPlaying ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
                </button>
            </div>

            {/* Tier 2: Overflow menu for secondary actions */}
            <div className="reader-nav-more" ref={moreRootRef}>
                <button
                    ref={moreTriggerRef}
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={() => setMoreOpen((open) => !open)}
                    aria-expanded={moreOpen}
                    aria-haspopup="true"
                    aria-label="More reader actions"
                >
                    <MoreVertical size={16} aria-hidden="true" />
                </button>
                {moreOpen ? (
                    <div className="reader-nav-menu" aria-label="More reader actions">
                        <div className="reader-nav-menu-group" role="group" aria-label="Search">
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
                        <div className="reader-nav-menu-group" role="group" aria-label="Track narration">
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
                        <div className="reader-nav-menu-group" role="group" aria-label="Export">
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
                        </div>
                        <div className="reader-nav-menu-group" role="group" aria-label="Bookmarks">
                            {bookmarks.length ? (
                                <select
                                    className="bookmark-jump"
                                    aria-label="Go to bookmark"
                                    value=""
                                    onChange={(event) => {
                                        if (event.target.value) {
                                            onGoToPage(Number(event.target.value));
                                            closeMore();
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
                    </div>
                ) : null}
            </div>
        </div>
    );
}
