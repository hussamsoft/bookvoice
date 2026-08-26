import { useCallback, useEffect, useRef, useState } from 'react';

export const SLEEP_END_OF_CHAPTER = 'chapter';
export const SLEEP_MINUTE_OPTIONS = [5, 10, 15, 30, 45, 60];

const TICK_MS = 250;

function normalizeSelection(value) {
    if (value === SLEEP_END_OF_CHAPTER) return SLEEP_END_OF_CHAPTER;
    const minutes = Number(value);
    if (SLEEP_MINUTE_OPTIONS.includes(minutes)) return minutes;
    return null; // off
}

/**
 * Audiobook-style sleep timer.
 *
 * Two modes: a fixed number of minutes (counts down only while `playing` is
 * true — pausing playback freezes the countdown), and "end of chapter",
 * which fires once when the consumer reports that the current page finished
 * playing naturally via notifyPageEnded(). Expiry invokes onExpire exactly
 * once and resets the timer to Off.
 */
export function useSleepTimer({ playing = false, onExpire } = {}) {
    const [minutes, setMinutesState] = useState(null);
    const [remainingMs, setRemainingMs] = useState(null);
    const remainingRef = useRef(null);
    const firedRef = useRef(false);
    const selectionRef = useRef(null);
    const onExpireRef = useRef(onExpire);
    onExpireRef.current = onExpire;

    const select = useCallback((value) => {
        const next = normalizeSelection(value);
        selectionRef.current = next;
        firedRef.current = false;
        setMinutesState(next);
        if (typeof next === 'number') {
            remainingRef.current = next * 60000;
            setRemainingMs(remainingRef.current);
        } else {
            remainingRef.current = null;
            setRemainingMs(null);
        }
    }, []);

    const cancel = useCallback(() => select(null), [select]);

    const fire = useCallback(() => {
        if (firedRef.current) return;
        firedRef.current = true;
        selectionRef.current = null;
        remainingRef.current = null;
        setRemainingMs(null);
        setMinutesState(null);
        onExpireRef.current?.();
    }, []);

    // "End of chapter" mode: fire exactly once when the page ends naturally.
    const notifyPageEnded = useCallback(() => {
        if (selectionRef.current === SLEEP_END_OF_CHAPTER) fire();
    }, [fire]);

    useEffect(() => {
        if (typeof minutes !== 'number' || !playing) return undefined;
        let last = Date.now();
        const timer = setInterval(() => {
            const now = Date.now();
            const elapsed = now - last;
            last = now;
            const next = Math.max(0, (remainingRef.current ?? 0) - elapsed);
            remainingRef.current = next;
            setRemainingMs(next);
            if (next <= 0) fire();
        }, TICK_MS);
        return () => clearInterval(timer);
    }, [minutes, playing, fire]);

    return {
        minutes,
        setMinutes: select,
        remainingMs,
        active: minutes !== null,
        cancel,
        notifyPageEnded,
    };
}
