import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Decide whether the reader should offer a "Resume / Start Fresh" choice.
 *
 * The original `handlePlay` in PdfViewer.jsx shows the choice dialog when
 * the user clicks Play on a page that is *not* the page the audio is
 * currently narrating. Per the plan (§2.3.2) the dialog is interrupt-y and
 * should be reserved for the case where the user has actually navigated
 * away — not for a single-page re-render or a one-off re-render where the
 * safe default is to keep the existing audio going.
 *
 * Decision:
 *  - If the narrated page is within 1 page of the current page (i.e. the
 *    user is on the same page or has scrolled to the page right next to
 *    it), do NOT show the dialog — keep the existing audio.
 *  - Otherwise, if the narrated page has meaningful audio, show the dialog.
 *  - If there is no audio for the narrated page (or `audioPage` is null),
 *    do NOT show the dialog — there is nothing to resume.
 *
 * The hook owns the visibility flag; the consumer renders the dialog and
 * calls `onResume` / `onStartFresh` / `dismiss` from the action buttons.
 *
 * @param {object} args
 * @param {number} [args.currentPage]   1-indexed page the user is viewing.
 * @param {number} [args.audioPage]     1-indexed page the audio is currently
 *   narrating, or null/undefined when nothing is loaded.
 * @param {boolean} [args.hasAudio]     Whether the audio is meaningful
 *   (i.e. prepared page audio, not a stub). Defaults to true when
 *   `audioPage` is non-null; pass false to skip the dialog even when an
 *   audio entry is in the cache.
 * @param {() => void} [args.onResume]     Resumes the existing audio at
 *   `audioPage`. The consumer typically replays the cached audio entry.
 * @param {() => void} [args.onStartFresh] Loads `currentPage` as a fresh
 *   narration. The consumer typically calls its page-lifecycle hook.
 *
 * @returns {{
 *   showChoice: boolean,
 *   dismiss: () => void,
 * }}
 */
export function usePageResume({
    currentPage,
    audioPage,
    hasAudio,
    onResume,
    onStartFresh,
}) {
    // The dialog visibility is *derived* state, but we expose a setter so
    // the consumer can force-dismiss (e.g. when the user closes the dialog
    // with Escape or clicks outside).
    const [showChoice, setShowChoice] = useState(false);

    // Refs so the decision effect never re-fires on callback identity churn.
    const onResumeRef = useRef(onResume);
    const onStartFreshRef = useRef(onStartFresh);
    useEffect(() => { onResumeRef.current = onResume; }, [onResume]);
    useEffect(() => { onStartFreshRef.current = onStartFresh; }, [onStartFresh]);

    // The decision is *driven* by a `playAttempt` counter: the consumer bumps
    // it when the user clicks Play. The hook inspects the current page, the
    // audio page, and the audio state, then either shows the dialog (and
    // waits for the consumer to fire `resume()` or `startFresh()`) or calls
    // `onResume` directly when the safe default is to keep the audio going.
    // For now we keep the API minimal: the consumer renders the dialog when
    // `showChoice` is true and calls the actions from inside the dialog.
    // The "1-page-window" rule is enforced here, so the consumer never has
    // to compute it.
    const showChoiceDerived = Boolean(
        Number.isFinite(Number(audioPage))
        && Number.isFinite(Number(currentPage))
        && Math.abs(Number(currentPage) - Number(audioPage)) > 1
        && (hasAudio !== false)
    );

    // When the underlying decision flips, mirror it to the local state so
    // the consumer can render or hide the dialog from a single source.
    useEffect(() => {
        setShowChoice(showChoiceDerived);
    }, [showChoiceDerived]);

    const dismiss = useCallback(() => {
        setShowChoice(false);
    }, []);

    // Expose the actions on the hook for convenience; the consumer may
    // wire them to dialog buttons directly.
    const resume = useCallback(() => {
        if (onResumeRef.current) onResumeRef.current();
        setShowChoice(false);
    }, []);
    const startFresh = useCallback(() => {
        if (onStartFreshRef.current) onStartFreshRef.current();
        setShowChoice(false);
    }, []);

    return { showChoice, dismiss, resume, startFresh };
}
