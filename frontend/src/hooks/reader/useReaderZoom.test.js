import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useReaderZoom } from './useReaderZoom';

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

const wheelEvent = (overrides = {}) => ({
    deltaY: 1,
    ctrlKey: true,
    preventDefault: vi.fn(),
    ...overrides,
});

describe('useReaderZoom', () => {
    it('starts at the initial value (clamped to bounds)', () => {
        const { result } = renderHook(() => useReaderZoom({ initial: 0.5 }));
        // 0.5 is below the default min of 0.7; the hook clamps.
        expect(result.current.zoom).toBe(0.7);

        const upper = renderHook(() => useReaderZoom({ initial: 5, max: 2.6 }));
        expect(upper.result.current.zoom).toBe(2.6);
    });

    it('in() and out() step by `step` and clamp at the bounds', () => {
        const { result } = renderHook(() => useReaderZoom({ initial: 1, step: 0.1 }));
        act(() => result.current.in());
        expect(result.current.zoom).toBe(1.1);
        act(() => result.current.in());
        expect(result.current.zoom).toBe(1.2);
        act(() => result.current.out());
        expect(result.current.zoom).toBe(1.1);
        act(() => result.current.out());
        expect(result.current.zoom).toBe(1.0);

        // Clamp at the lower bound (0.7) — enough calls to walk from 1.0
        // to 0.0 and beyond, so the clamp engages.
        for (let i = 0; i < 5; i++) act(() => result.current.out());
        expect(result.current.zoom).toBe(0.7);
    });

    it('fit() resets to 1', () => {
        const { result } = renderHook(() => useReaderZoom({ initial: 1.5 }));
        act(() => result.current.fit());
        expect(result.current.zoom).toBe(1);
    });

    it('set() clamps and updates zoom', () => {
        const { result } = renderHook(() => useReaderZoom());
        act(() => result.current.set(2.0));
        expect(result.current.zoom).toBeCloseTo(2.0);
        act(() => result.current.set(99));
        expect(result.current.zoom).toBe(2.6);
        act(() => result.current.set(0));
        expect(result.current.zoom).toBe(0.7);
    });

    it('displayZoom lags zoom by the debounce window', async () => {
        const { result } = renderHook(() => useReaderZoom({ initial: 1, debounceMs: 50 }));
        act(() => result.current.set(1.5));
        // Before the debounce window, displayZoom is still the previous value.
        expect(result.current.zoom).toBe(1.5);
        expect(result.current.displayZoom).toBe(1);
        await act(async () => { await wait(60); });
        expect(result.current.displayZoom).toBe(1.5);
    });

    it('a burst of wheel ticks debounces into a single display update', async () => {
        const { result } = renderHook(() => useReaderZoom({ initial: 1, debounceMs: 50, step: 0.1 }));
        act(() => result.current.in());
        act(() => result.current.in());
        act(() => result.current.in());
        expect(result.current.zoom).toBe(1.3);
        expect(result.current.displayZoom).toBe(1);
        await act(async () => { await wait(60); });
        expect(result.current.displayZoom).toBe(1.3);
    });

    it('onWheel zooms in on a negative deltaY and out on positive (with Ctrl)', () => {
        const { result } = renderHook(() => useReaderZoom({ initial: 1, step: 0.1 }));
        const evIn = wheelEvent({ deltaY: -1, ctrlKey: true });
        act(() => result.current.onWheel(evIn));
        expect(evIn.preventDefault).toHaveBeenCalled();
        expect(result.current.zoom).toBe(1.1);

        const evOut = wheelEvent({ deltaY: 1, ctrlKey: true });
        act(() => result.current.onWheel(evOut));
        expect(evOut.preventDefault).toHaveBeenCalled();
        expect(result.current.zoom).toBe(1.0);
    });

    it('onWheel ignores a plain wheel (no Ctrl/Cmd) — no preventDefault, no zoom', () => {
        const { result } = renderHook(() => useReaderZoom({ initial: 1 }));
        const ev = wheelEvent({ deltaY: -1, ctrlKey: false });
        act(() => result.current.onWheel(ev));
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect(result.current.zoom).toBe(1);
    });

    it('onWheel respects the canZoom gate (e.g. no document loaded)', () => {
        const { result } = renderHook(() => useReaderZoom({ initial: 1, canZoom: () => false }));
        const ev = wheelEvent();
        act(() => result.current.onWheel(ev));
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect(result.current.zoom).toBe(1);
    });

    it('exposes min and max for the consumer to drive the +/- disabled state', () => {
        const { result } = renderHook(() => useReaderZoom({ min: 0.5, max: 3, step: 0.25 }));
        expect(result.current.min).toBe(0.5);
        expect(result.current.max).toBe(3);
    });
});
