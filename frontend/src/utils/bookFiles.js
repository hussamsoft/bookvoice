/**
 * File helpers for opening books in the reader.
 */

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
 * Build the synthetic `File` that represents a prepared library book.
 *
 * The `lastModified` stamp comes from the book's `updatedAt`, which keeps
 * `documentFingerprint(file)` — and therefore the saved reading progress —
 * stable across re-opens. PDFs read from the fetched source blob; text
 * books read their pages from the server, so no source blob is needed or
 * fetched.
 */
export function libraryBookFile(book, source = null) {
    const kind = book?.sourceKind || 'pdf';
    const lastModified = Number(book?.updatedAt || Date.now()) * 1000;
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
