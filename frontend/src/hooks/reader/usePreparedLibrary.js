import { useCallback, useEffect, useState } from 'react';
import { listPreparedBooks } from '../../utils/api';

/**
 * Prepared-book library state.
 *
 * The original PdfViewer owned `libraryBooks`, `libraryPending`, the
 * `useEffect` that loads the list on mount, and the polling-style
 * `updatePreparedProgress` side effect. This hook lifts the *list* out
 * (refresh, isLoading, setList) and leaves the per-book progress sync
 * to the consumer — different books need different progress fields, and
 * the consumer's throttle/visibility-flush lives in `useReaderProgress`.
 *
 * @param {object} [args]
 * @param {(error: Error) => void} [args.onError]  Toast-style handler for
 *   load failures. The hook does not call `toast` directly so it stays
 *   independent of the toast system.
 *
 * @returns {{
 *   books: object[],
 *   isLoading: boolean,
 *   refresh: () => Promise<void>,
 *   setBooks: (next: object[]) => void,
 * }}
 */
export function usePreparedLibrary({ onError } = {}) {
    const [books, setBooks] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    const refresh = useCallback(async () => {
        try {
            const next = await listPreparedBooks();
            setBooks(Array.isArray(next) ? next : []);
            return next;
        } catch (error) {
            if (onError) onError(error instanceof Error ? error : new Error(String(error)));
            return null;
        } finally {
            setIsLoading(false);
        }
    }, [onError]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const next = await listPreparedBooks();
                if (cancelled) return;
                setBooks(Array.isArray(next) ? next : []);
            } catch (error) {
                if (cancelled) return;
                if (onError) onError(error instanceof Error ? error : new Error(String(error)));
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        })();
        return () => { cancelled = true; };
        // The initial fetch runs once on mount; later updates go through
        // the returned `refresh` function.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return { books, isLoading, refresh, setBooks };
}
