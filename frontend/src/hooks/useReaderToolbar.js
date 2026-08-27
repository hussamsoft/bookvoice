import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Encapsulates the reader toolbar's local UI state (overflow menu open,
 * focus management, outside-click dismissal) so PdfViewer.jsx doesn't have
 * to own it inline. The actual navigation/playback handlers stay in PdfViewer
 * and are passed in.
 */
export function useReaderToolbar() {
    const [moreOpen, setMoreOpen] = useState(false);
    const moreRootRef = useRef(null);
    const moreTriggerRef = useRef(null);

    const closeMore = useCallback(() => {
        setMoreOpen(false);
        moreTriggerRef.current?.focus();
    }, []);


    useEffect(() => {
        if (!moreOpen) return undefined;
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                closeMore();
                return;
            }
            if (event.key !== 'Tab' || !moreRootRef.current) return;
            const focusable = moreRootRef.current.querySelectorAll(
                'button:not(:disabled), select:not(:disabled), input:not([type="hidden"]), a[href]',
            );
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if ((event.shiftKey && document.activeElement === first)
                || (!event.shiftKey && document.activeElement === last)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            }
        };
        const onMouseDown = (event) => {
            if (moreRootRef.current && !moreRootRef.current.contains(event.target)) {
                closeMore();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('mousedown', onMouseDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('mousedown', onMouseDown);
        };
    }, [moreOpen, closeMore]);

    return {
        moreOpen,
        setMoreOpen,
        moreRootRef,
        moreTriggerRef,
        closeMore,
    };
}
