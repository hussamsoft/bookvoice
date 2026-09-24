import { documentFingerprint } from './readingProgress';

/**
 * File helpers for opening books in the reader.
 */

const PREPARED_BOOK_EPOCH_FALLBACK = 0;

/**
 * Guess the book kind from a file name. Text books (.epub/.txt/.md) have
 * their pages served from the server manifest; only PDFs render locally.
 */
export function sourceKindFromName(name = '') {
    if (/\.epub$/i.test(name)) return 'epub';
    if (/\.(txt|md)$/i.test(name)) return 'txt';
    return 'pdf';
}

/**
 * Stable local-progress identity for an open Reader document.
 * Prepared books use their immutable server id; only local, unimported
 * uploads fall back to the browser file fingerprint.
 */
export function readerProgressId(book, file) {
    const serverId = book?.id;
    return serverId != null && String(serverId) !== ''
        ? String(serverId)
        : documentFingerprint(file);
}

/**
 * Build the synthetic `File` that renders a prepared library book.
 * This is a rendering adapter, not the saved-progress identity. Use
 * `readerProgressId` for that. PDFs read the fetched source blob; text books
 * read their pages from the server, so they need no source blob.
 */
export function libraryBookFile(book, source = null) {
    const kind = book?.sourceKind || 'pdf';
    const stampSeconds = Number(book?.updatedAt) || PREPARED_BOOK_EPOCH_FALLBACK;
    const lastModified = stampSeconds * 1000;
    if (kind === 'pdf') {
        return new File([source || ''], `${book?.title || 'Prepared book'}.pdf`, {
            type: 'application/pdf',
            lastModified,
        });
    }
    return new File([], `${book?.title || 'Prepared book'}.${kind}`, {
        type: 'text/plain',
        lastModified,
    });
}
