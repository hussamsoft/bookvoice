/**
 * Resolve reader content from the persistent library before touching the PDF.
 * Prepared text is authoritative for its matching profile and avoids repeating
 * PDF extraction or OCR every time a warmed book is opened.
 */
export async function resolvePageContent({
    bookId,
    profileId,
    page,
    getPreparedPage,
    preparePageText,
}) {
    if (bookId && profileId) {
        try {
            const prepared = await getPreparedPage(bookId, profileId, page);
            const text = String(prepared?.text || '').trim();
            if (text) {
                return { text, prepared, source: 'prepared' };
            }
        } catch {
            // Library reads must degrade to the source PDF instead of blocking it.
        }
    }

    const text = await preparePageText(page);
    return { text, prepared: null, source: 'pdf' };
}
