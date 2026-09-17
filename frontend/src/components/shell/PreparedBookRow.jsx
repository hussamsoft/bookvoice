import React from 'react';
import { preparedBookDetails } from '../../utils/preparedPages';

const SOURCE_KIND_LABELS = {
    pdf: 'PDF',
    epub: 'EPUB',
    txt: 'Text',
    md: 'Markdown',
};

/**
 * A library book row: source badge, title, and where you left off.
 * Shared by the Library view, Home's continue-reading list, and the
 * readers' open-a-book state.
 */
const PreparedBookRow = React.memo(function PreparedBookRow({ book, onOpen }) {
    const details = preparedBookDetails(book);
    const kind = book.sourceKind || 'pdf';
    const badge = SOURCE_KIND_LABELS[kind] || kind.toUpperCase();
    return (
        <button
            type="button"
            className="prepared-book-row"
            onClick={() => onOpen(book)}
        >
            <span className="prepared-book-row-heading">
                <span className="source-kind-badge">
                    {badge}
                </span>
                {book.title}
            </span>
            <small>
                Continue page {details.resumePage} · {details.preparedPages}/{details.pageCount || '—'} narrated
                {details.bookmarks.length ? ` · Bookmarks ${details.bookmarks.join(', ')}` : ''}
            </small>
        </button>
    );
});

export default PreparedBookRow;
