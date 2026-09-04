import { useCallback, useRef } from 'react';
import { getBookPage } from '../../utils/api';
import { mapWithConcurrency } from '../../utils/boundedConcurrency';

/**
 * Server-side page text for text books (.epub/.txt/.md).
 *
 * Their pages never exist locally: each one is fetched once from the
 * prepared-book library, cached, and then reused for display, find-in-book,
 * and (later) narration. Cache keys include the book id, so opening another
 * book can never see stale pages; `clear` drops the cache when the reader
 * swaps documents.
 *
 * `findText` warms the whole book with bounded concurrency, then scans in
 * wrap-around order starting at `startPage` — the same search semantics as
 * the PDF text-layer scan in `usePdfDocument.findTextInDocument`, and the
 * contract `useReaderSearch` expects.
 *
 * The book id is a parameter (not hook state) so the caller can pass its
 * synchronously-updated ref: the first `fetchPage` of a freshly activated
 * book runs before the next React commit would have flushed a new id.
 *
 * @param {object} [args]
 * @param {number} [args.totalPages]  Page count used to bound the search scan.
 * @returns {{
 *   fetchPage: (bookId: string, page: number) => Promise<string>,
 *   findText: (bookId: string, query: string, startPage?: number) => Promise<number | null>,
 *   clear: () => void,
 * }}
 */
export function useServerPageText({ totalPages } = {}) {
    const cacheRef = useRef(new Map());

    const fetchPage = useCallback(async (bookId, page) => {
        const key = `${bookId}:${page}`;
        const cached = cacheRef.current.get(key);
        if (cached != null) return cached;
        const data = await getBookPage(bookId, page);
        const text = String(data?.text || '').trim();
        if (!text) throw new Error(`No text found on page ${page}.`);
        cacheRef.current.set(key, text);
        return text;
    }, []);

    const findText = useCallback(
        async (bookId, query, startPage = 1) => {
            const needle = String(query || '').trim().toLocaleLowerCase();
            const total = Number(totalPages) || 0;
            if (!needle || !bookId || !total) return null;
            // Warm the cache with bounded concurrency, then match in
            // wrap-around order starting at `startPage`.
            const pages = Array.from({ length: total }, (_, index) => index + 1);
            await mapWithConcurrency(pages, 3, async (page) => {
                try {
                    await fetchPage(bookId, page);
                } catch {
                    /* unreadable pages simply never match */
                }
            });
            const first = Math.max(1, Math.min(total, Number(startPage) || 1));
            for (let offset = 0; offset < total; offset += 1) {
                const pageNum = ((first - 1 + offset) % total) + 1;
                const text = cacheRef.current.get(`${bookId}:${pageNum}`) || '';
                if (text.toLocaleLowerCase().includes(needle)) return pageNum;
            }
            return null;
        },
        [fetchPage, totalPages]
    );

    const clear = useCallback(() => {
        cacheRef.current.clear();
    }, []);

    return { fetchPage, findText, clear };
}
