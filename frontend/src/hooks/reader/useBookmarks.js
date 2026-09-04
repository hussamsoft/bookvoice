import { useCallback, useState } from 'react';
import { toggleBookmark as toggleBookmarkPure } from '../../utils/readingProgress';

/**
 * Per-document bookmark list with toggle / set / query actions.
 *
 * Wraps the pure `toggleBookmark` from `utils/readingProgress.js` with
 * React state. The list is sorted ascending and deduplicated (the pure
 * helper enforces both), so consumers can render pages in order without
 * sorting on their side.
 *
 * Persistence is the consumer's job: pass the loaded list via `initial` on
 * book open and read `bookmarks` to write back on the next save cycle.
 * This keeps the hook decoupled from `localStorage` and the server-side
 * prepared-book save path.
 *
 * @param {object} [args]
 * @param {number[]} [args.initial=[]]
 *
 * @returns {{
 *   bookmarks: number[],
 *   toggle: (page: number) => void,
 *   set: (next: number[]) => void,
 *   clear: () => void,
 *   isBookmarked: (page: number) => boolean,
 * }}
 */
export function useBookmarks({ initial = [] } = {}) {
    const [bookmarks, setBookmarks] = useState(() =>
        Array.isArray(initial) ? [...initial] : []
    );

    const toggle = useCallback((page) => {
        setBookmarks((current) => toggleBookmarkPure(current, page));
    }, []);

    const set = useCallback((next) => {
        if (!Array.isArray(next)) return;
        // Deduplicate and sort via the same pure helper, so a hand-edited
        // list goes through the same normalisation the toggle path uses.
        const seen = new Set();
        const sorted = [...next]
            .map((p) => Math.floor(Number(p)))
            .filter((p) => Number.isFinite(p) && p > 0 && !seen.has(p) && seen.add(p))
            .sort((a, b) => a - b);
        setBookmarks(sorted);
    }, []);

    const clear = useCallback(() => {
        setBookmarks([]);
    }, []);

    const isBookmarked = useCallback(
        (page) => bookmarks.includes(page),
        [bookmarks]
    );

    return { bookmarks, toggle, set, clear, isBookmarked };
}
