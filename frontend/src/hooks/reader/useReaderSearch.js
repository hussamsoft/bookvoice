import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Wrap-around search across the open book.
 *
 * Wraps a "finder" (PDF text-layer or text-book server pages) with the
 * orchestrator state the reader needs: an `isSearching` flag, the last
 * result, the last error, a `submit` trigger that ignores stale responses
 * if a newer query is in flight, and an optional debounce.
 *
 * The finder itself is expected to:
 *  - accept `(query: string, startPage: number)` and return the page
 *    number where the query first matches, or `null` if no match.
 *  - start scanning at `startPage` and wrap to page 1 when reaching the
 *    end (so a fresh search from the current page finds the *next* match,
 *    not the one already on screen).
 *
 * The hook does not navigate to the found page; the consumer calls its
 * page-navigation hook with the returned page number.
 *
 * @param {object} args
 * @param {(query: string, startPage: number) => Promise<number | null>} args.findInDocument
 * @param {number} args.currentPage    1-indexed current page. Search starts
 *   at `currentPage + 1` so the *next* match wins, not the one on screen.
 * @param {number} [args.totalPages]   Total pages; if 0/null/undefined the
 *   search is a no-op (there is nothing to scan).
 * @param {number} [args.debounceMs=0] Delay before invoking the finder; 0
 *   means submit immediately. Use 200-300 for "search as you type".
 * @returns {{
 *   submit: (query: string) => void,
 *   isSearching: boolean,
 *   result: number | null,
 *   error: Error | null,
 *   reset: () => void,
 * }}
 */
export function useReaderSearch({
    findInDocument,
    currentPage,
    totalPages,
    debounceMs = 0,
}) {
    const [isSearching, setIsSearching] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);

    // Bumped on every submit (and on reset/unmount). An async resolution
    // whose epoch is no longer current is dropped, so only the most recent
    // submit can update `result` / `error` / `isSearching`.
    const epochRef = useRef(0);
    // Handle for a pending debounce timer, if any.
    const debounceRef = useRef(null);
    // The finder changes when the book changes (PDF vs text book). Keeping
    // it in a ref means a change in `findInDocument` does not abort an
    // in-flight search; the *next* submit picks up the new finder.
    const findInDocumentRef = useRef(findInDocument);

    useEffect(() => {
        findInDocumentRef.current = findInDocument;
    }, [findInDocument]);

    const reset = useCallback(() => {
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
        // Bump the epoch so a pending run from an earlier submit is dropped.
        epochRef.current += 1;
        setIsSearching(false);
        setResult(null);
        setError(null);
    }, []);

    const submit = useCallback(
        (query) => {
            const trimmed = String(query == null ? '' : query).trim();
            if (!trimmed || !totalPages) {
                // No query or no book: clear any prior result and bail.
                setResult(null);
                setError(null);
                setIsSearching(false);
                return;
            }
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
            }
            const epoch = ++epochRef.current;
            setError(null);

            const run = async () => {
                setIsSearching(true);
                try {
                    const startPage = Math.max(1, (Number(currentPage) || 1) + 1);
                    const finder = findInDocumentRef.current;
                    const found = finder
                        ? await finder(trimmed, startPage)
                        : null;
                    if (epoch !== epochRef.current) return;
                    setResult(Number.isFinite(found) ? found : null);
                } catch (e) {
                    if (epoch !== epochRef.current) return;
                    setError(e instanceof Error ? e : new Error(String(e)));
                    setResult(null);
                } finally {
                    // Only the most recent submit may end the spinner.
                    if (epoch === epochRef.current) {
                        setIsSearching(false);
                    }
                }
            };

            if (debounceMs > 0) {
                debounceRef.current = setTimeout(run, debounceMs);
            } else {
                run();
            }
        },
        [currentPage, totalPages, debounceMs]
    );

    // On unmount: drop any pending debounce and bump the epoch so a late
    // resolution is a no-op (the consumer's component is gone).
    useEffect(() => () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        epochRef.current += 1;
    }, []);

    return { submit, isSearching, result, error, reset };
}
