import { useCallback, useEffect, useRef, useState } from 'react';
import { shouldZoomPdfWheel } from '../../utils/pdfInteraction';

const DEFAULT_MIN = 0.7;
const DEFAULT_MAX = 2.6;
const DEFAULT_STEP = 0.15;
const DEFAULT_DISPLAY_DEBOUNCE_MS = 80;

/**
 * PDF zoom state with debounced display value, wheel handler, and
 * fit / in / out / set actions.
 *
 * The original PdfViewer keeps two state slots: `zoom` (the value the
 * rest of the app reads) and `displayZoom` (the value applied to the
 * CSS `transform`, lagged by ~80 ms to avoid layout thrash on rapid
 * wheel ticks). This hook preserves that split so the consumer can pass
 * `displayZoom` to `<Page style={{ zoom: displayZoom }}>` (or a transform)
 * without re-rendering on every wheel tick.
 *
 * The wheel handler requires a guard (`shouldZoomPdfWheel`) so plain
 * wheel scrolls still scroll the container; only Ctrl/Cmd+wheel zooms.
 * Pass the returned `onWheel` directly to the scroll container.
 *
 * @param {object} [args]
 * @param {number} [args.initial=1]              Initial zoom (clamped).
 * @param {number} [args.min=0.7]                Minimum zoom.
 * @param {number} [args.max=2.6]                Maximum zoom.
 * @param {number} [args.step=0.15]              Step per wheel notch / button.
 * @param {number} [args.debounceMs=80]          Debounce window for `displayZoom`.
 * @param {() => boolean} [args.canZoom]         Optional gate (e.g. require a
 *   document loaded). Defaults to always-true.
 *
 * @returns {{
 *   zoom: number,           // authoritative value
 *   displayZoom: number,    // debounced for CSS / transforms
 *   set: (next: number) => void,
 *   in: () => void,
 *   out: () => void,
 *   fit: () => void,
 *   onWheel: (ev: WheelEvent) => void,
 *   min: number,
 *   max: number,
 * }}
 */
export function useReaderZoom({
    initial = 1,
    min = DEFAULT_MIN,
    max = DEFAULT_MAX,
    step = DEFAULT_STEP,
    debounceMs = DEFAULT_DISPLAY_DEBOUNCE_MS,
    canZoom,
} = {}) {
    const clamp = useCallback(
        (value) => {
            // Match the original PdfViewer behavior: round to 2 decimals so
            // accumulated float math doesn't display "1.2000000000000002".
            // Use `??` rather than `||` so `set(0)` clamps to the lower
            // bound instead of falling back to 1.
            const numeric = Number(value);
            const safe = Number.isFinite(numeric) ? numeric : 1;
            const rounded = Math.round(safe * 100) / 100;
            return Math.max(min, Math.min(max, rounded));
        },
        [min, max]
    );

    const [zoom, setZoomState] = useState(() => clamp(initial));
    const [displayZoom, setDisplayZoom] = useState(() => clamp(initial));
    const debounceRef = useRef(null);

    // Authoritative set: always clamps; updates both `zoom` and (after
    // debounce) `displayZoom`. The consumer can pass any value here; the
    // hook enforces bounds.
    const set = useCallback(
        (next) => {
            setZoomState(clamp(next));
        },
        [clamp]
    );

    // Debounce the display value so a burst of wheel ticks only triggers
    // one CSS-update downstream.
    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => setDisplayZoom(zoom), debounceMs);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [zoom, debounceMs]);

    const inZoom = useCallback(() => {
        setZoomState((current) => clamp(current + step));
    }, [clamp, step]);
    const outZoom = useCallback(() => {
        setZoomState((current) => clamp(current - step));
    }, [clamp, step]);
    const fit = useCallback(() => {
        setZoomState(1);
    }, []);

    // Wheel handler. Plain wheel scrolls the container; Ctrl/Cmd+wheel
    // zooms. The guard lives in `utils/pdfInteraction` so the reader and
    // any future page viewer share the same modifier policy.
    const onWheel = useCallback(
        (event) => {
            if (!shouldZoomPdfWheel(event)) return;
            if (canZoom && !canZoom()) return;
            event.preventDefault();
            const direction = event.deltaY < 0 ? 1 : -1;
            setZoomState((current) => clamp(current + direction * step));
        },
        [clamp, step, canZoom]
    );

    // On unmount, drop the debounce so a pending display update never
    // runs against a torn-down component.
    useEffect(() => () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
    }, []);

    return { zoom, displayZoom, set, in: inZoom, out: outZoom, fit, onWheel, min, max };
}
