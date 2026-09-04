import { useCallback, useEffect, useRef } from 'react';
import { saveReadingProgress } from '../../utils/readingProgress';

const DEFAULT_AUTOSAVE_MS = 3000;

/**
 * Throttled autosave of reading progress to localStorage.
 *
 * Behaviour:
 *  - **Leading-edge throttle**: the first state change after a flush starts
 *    a timer; subsequent changes within the window overwrite the pending
 *    snapshot but do NOT reset the timer. Writes happen at most once per
 *    `intervalMs`, even when `transport.currentTime` ticks every animation
 *    frame during uninterrupted playback.
 *  - **Last-write-wins**: the closure stored in `pendingFlushRef` is rebuilt
 *    on every state change, so the eventual write reflects the *latest*
 *    values, not the values at the moment the timer was armed.
 *  - **Visibility flush**: `pagehide` and `visibilitychange` (tab hidden,
 *    app backgrounded, OS shutdown) write the current state immediately so
 *    closing the tab never loses the latest position.
 *  - **Unmount flush**: the pending write is persisted before the component
 *    tears down.
 *
 * Pass `documentId` to enable saving. A falsy `documentId` drops any
 * pending write and turns the hook into a no-op until one is set.
 *
 * @param {object} args
 * @param {string} args.documentId         Required identity of the open book.
 * @param {number} args.page               1-indexed current page.
 * @param {number} args.time               Current playback time in seconds.
 * @param {number} args.zoom               PDF zoom factor (0.7 - 2.6).
 * @param {number} args.playbackRate       Playback rate (0.75, 1, 1.25, 1.5, 2).
 * @param {number[]} args.bookmarks        Page numbers marked by the user.
 * @param {number} [args.intervalMs=3000]  Throttle window in milliseconds.
 * @returns {{ flush: () => void }}        Manual flush trigger.
 */
export function useReaderProgress({
    documentId,
    page,
    time,
    zoom,
    playbackRate,
    bookmarks,
    intervalMs = DEFAULT_AUTOSAVE_MS,
}) {
    // The latest snapshot closure. The closure captures the values of the
    // effect run that created it, so each state change overwrites it with a
    // closure that has the newest values.
    const pendingFlushRef = useRef(null);
    // The handle of the pending leading-edge timer. `null` when no write is
    // scheduled. Cleared by the timer body, the visibility listener, or a
    // manual `flush()` call.
    const timerRef = useRef(null);

    // Stable. Drains the pending snapshot (if any) and clears the outstanding
    // timer. Called from the setTimeout body, the visibility listener, and
    // any caller that uses the returned `flush()`.
    const flush = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        const snapshot = pendingFlushRef.current;
        pendingFlushRef.current = null;
        if (snapshot) snapshot();
    }, []);

    // Main autosave effect. Runs on every state change; the leading-edge
    // throttle is enforced by only arming the timer when none is pending.
    useEffect(() => {
        if (!documentId) {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            pendingFlushRef.current = null;
            return undefined;
        }

        // Always rebuild the snapshot for the *current* state. The closure
        // captures the values of this effect run, so the next effect run
        // overwrites it with the latest values.
        pendingFlushRef.current = () => {
            saveReadingProgress(documentId, { page, time, zoom, playbackRate, bookmarks });
        };

        // Leading-edge throttle: only arm a new timer if one isn't already
        // pending. Subsequent changes within the window overwrite the
        // snapshot but do NOT reset the timer.
        if (timerRef.current == null) {
            timerRef.current = setTimeout(flush, intervalMs);
        }

        return undefined;
    }, [documentId, page, time, zoom, playbackRate, bookmarks, intervalMs, flush]);

    // Visibility / pagehide flush. Registered once against the stable
    // `flush`. The hook intentionally uses both events because Safari on iOS
    // does not always fire `visibilitychange` reliably on background, and
    // desktop browsers prefer `pagehide` for tab-close.
    useEffect(() => {
        const onHide = () => flush();
        window.addEventListener('pagehide', onHide);
        document.addEventListener('visibilitychange', onHide);
        return () => {
            window.removeEventListener('pagehide', onHide);
            document.removeEventListener('visibilitychange', onHide);
        };
    }, [flush]);

    // Unmount-only flush (empty deps, so the cleanup runs only when the
    // component is actually torn down). The main effect's cleanup runs on
    // every dep change, which is not the same as unmount.
    useEffect(() => () => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        const snapshot = pendingFlushRef.current;
        pendingFlushRef.current = null;
        if (snapshot) snapshot();
    }, []);

    return { flush };
}
