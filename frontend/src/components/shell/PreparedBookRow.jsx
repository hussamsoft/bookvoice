import React from 'react';
import { MoreHorizontal } from 'lucide-react';
import { preparedBookDetails, preparationForActiveProfile } from '../../utils/preparedPages';

const SOURCE_KIND_LABELS = {
    pdf: 'PDF',
    epub: 'EPUB',
    txt: 'Text',
    md: 'Markdown',
};

function coverInitials(title, kind) {
    const sourceTitle = String(title || '').trim();
    const words = sourceTitle.split(/\s+/).filter(Boolean);
    const initials = words.length > 1
        ? `${words[0][0]}${words[1][0]}`
        : (words[0]?.slice(0, 2) || String(kind || 'B').slice(0, 2)).toUpperCase();
    return initials;
}

function preparationLabel(book, job) {
    if (job) {
        const total = job.pageCount == null ? '' : ` of ${job.pageCount}`;
        return `${job.label}${job.pagesDone == null ? '' : ` · ${job.pagesDone}${total}`}`;
    }
    const preparation = preparationForActiveProfile(book);
    if (!preparation) return 'Not prepared';
    if (preparation.status === 'COMPLETED') return 'Ready to listen';
    if (preparation.status === 'FAILED') return preparation.error || 'Preparation failed';
    if (preparation.status === 'CANCELLED') return 'Preparation cancelled';
    if (preparation.status === 'PAUSED') return 'Preparation paused';
    return 'Preparing narration';
}

/**
 * Shared book opener. The title, cover fallback, progress, and preparation
 * state all live in one row; callers can add an overflow control beside it.
 */
const PreparedBookRow = React.memo(function PreparedBookRow({
    book,
    onOpen,
    job = null,
    actions = null,
    featured = false,
}) {
    const details = preparedBookDetails(book);
    const kind = book.sourceKind || 'pdf';
    const badge = SOURCE_KIND_LABELS[kind] || kind.toUpperCase();
    const rowClass = `prepared-book-row${featured ? ' is-featured' : ''}`;
    return (
        <div className="prepared-book-row-shell">
            <button type="button" className={rowClass} onClick={() => onOpen(book)}>
                <span className="prepared-book-cover" data-source-kind={kind} aria-hidden="true">
                    {coverInitials(book.title, kind)}
                </span>
                <span className="prepared-book-copy">
                    <span className="prepared-book-row-heading">
                        <span className="source-kind-badge">{badge}</span>
                        <span className="prepared-book-row-title">{book.title || 'Untitled book'}</span>
                    </span>
                    <small className="prepared-book-meta">
                        Continue page {details.resumePage} · {details.pageCount
                            ? `${details.preparedPages}/${details.pageCount} narrated`
                            : `${details.preparedPages} narrated`}
                    </small>
                    <small className="preparation-progress">{preparationLabel(book, job)}</small>
                </span>
            </button>
            {actions || <span className="prepared-book-overflow" aria-hidden="true"><MoreHorizontal size={16} /></span>}
        </div>
    );
});

export default PreparedBookRow;
