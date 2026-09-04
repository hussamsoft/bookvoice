import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Page-level reader orchestrator: browse vs. load, with race-cancel.
 *
 * Two entry points:
 *  - `browsePage(page)` — the user turned a page (prev/next, jump, scroll).
 *    The new page text is loaded, but nothing audio-related is touched.
 *  - `loadPage(page, { autoplay })` — the user activated a page for narration
 *    (clicked Play, restored from progress). The consumer's `onBeforeLoad`
 *    side-effect is invoked synchronously so it can pause audio, reset the
 *    playlist, and cancel in-flight generation *before* the new text
 *    resolves. When the text arrives, `onContent` is called with `kind: 'load'`
 *    and the consumer applies the audio.
 *
 * Both entry points use a single monotonic request id. Any in-flight call
 * whose id is no longer current (because the user turned a page again) is
 * dropped, so stale text never overwrites fresh text. The hook exposes
 * `isLoading` so the consumer can render a skeleton.
 *
 * The hook does *not* own the page text state, the audio transport, or the
 * library save. Those live in the consumer and run from the `onContent` /
 * `onError` callbacks. This keeps the hook testable without faking the PDF
 * proxy, the audio element, the toast system, or the library fetch.
 *
 * @param {object} args
 * @param {number} [args.totalPages]   Total pages in the open book; if 0/null
 *   the page is clamped to 1.
 * @param {(page: number) => Promise<{ text: string, source: string, prepared?: any }>} args.resolveContent
 *   Fetches the page text. The hook does not interpret the result.
 * @param {(text: string, source: string, ctx: { page: number, kind: 'browse' | 'load', autoplay: boolean }) => void | Promise<void>} [args.onContent]
 *   Called on a fresh, non-stale resolution. The consumer updates the page
 *   text state and (for `kind: 'load'`) applies or generates audio.
 * @param {() => void} [args.onBeforeLoad]
 *   Called synchronously at the start of `loadPage`. The consumer pauses
 *   audio, resets the playlist, cancels generation, etc.
 * @param {(err: Error, ctx: { page: number, kind: 'browse' | 'load' }) => void} [args.onError]
 *   Called on a fresh, non-stale rejection from `resolveContent`.
 *
 * @returns {{
 *   isLoading: boolean,
 *   browsePage: (page: number) => void,
 *   loadPage: (page: number, opts?: { autoplay?: boolean }) => void,
 * }}
 */
export function useReaderPageLifecycle({
    totalPages,
    resolveContent,
    onContent,
    onBeforeLoad,
    onError,
}) {
    const [isLoading, setIsLoading] = useState(false);
    // Bumped on every browse/load. Async work that resolves with a stale
    // id is dropped on the floor.
    const requestIdRef = useRef(0);
    // Latest resolveContent in a ref so a change in the source does not
    // abort an in-flight call.
    const resolveContentRef = useRef(resolveContent);
    const onContentRef = useRef(onContent);
    const onBeforeLoadRef = useRef(onBeforeLoad);
    const onErrorRef = useRef(onError);

    useEffect(() => { resolveContentRef.current = resolveContent; }, [resolveContent]);
    useEffect(() => { onContentRef.current = onContent; }, [onContent]);
    useEffect(() => { onBeforeLoadRef.current = onBeforeLoad; }, [onBeforeLoad]);
    useEffect(() => { onErrorRef.current = onError; }, [onError]);

    const clamp = useCallback(
        (page) => {
            const numeric = Math.floor(Number(page));
            if (!Number.isFinite(numeric)) return 1;
            if (totalPages && totalPages > 0) {
                return Math.max(1, Math.min(totalPages, numeric));
            }
            return Math.max(1, numeric);
        },
        [totalPages]
    );

    const run = useCallback(
        (page, { kind, autoplay }) => {
            const target = clamp(page);
            const requestId = ++requestIdRef.current;
            if (kind === 'load' && onBeforeLoadRef.current) {
                onBeforeLoadRef.current();
            }
            setIsLoading(true);

            (async () => {
                try {
                    const resolved = await resolveContentRef.current(target);
                    if (requestId !== requestIdRef.current) return; // a newer request superseded us
                    if (onContentRef.current) {
                        await onContentRef.current(
                            resolved?.text,
                            resolved?.source,
                            { page: target, kind, autoplay }
                        );
                    }
                    if (requestId === requestIdRef.current) {
                        setIsLoading(false);
                    }
                } catch (e) {
                    if (requestId !== requestIdRef.current) return;
                    if (onErrorRef.current) {
                        onErrorRef.current(
                            e instanceof Error ? e : new Error(String(e)),
                            { page: target, kind }
                        );
                    }
                    if (requestId === requestIdRef.current) {
                        setIsLoading(false);
                    }
                }
            })();
        },
        [clamp]
    );

    const browsePage = useCallback((page) => {
        run(page, { kind: 'browse', autoplay: false });
    }, [run]);

    const loadPage = useCallback((page, { autoplay = false } = {}) => {
        run(page, { kind: 'load', autoplay: !!autoplay });
    }, [run]);

    // On unmount, bump the request id so any pending resolution is dropped.
    useEffect(() => () => {
        requestIdRef.current += 1;
    }, []);

    return { isLoading, browsePage, loadPage };
}
