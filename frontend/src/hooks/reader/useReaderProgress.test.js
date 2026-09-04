import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReaderProgress } from './useReaderProgress';

// `saveReadingProgress` prefixes its argument with `bookvoice:reader:`.
// The test passes the unprefixed id to the hook and looks up the full key.
const DOC = 'test-doc';
const OTHER_DOC = 'other-doc';
const KEY = `bookvoice:reader:${DOC}`;
const OTHER_KEY = `bookvoice:reader:${OTHER_DOC}`;

const baseProps = {
    documentId: DOC,
    page: 1,
    time: 0,
    zoom: 1,
    playbackRate: 1,
    bookmarks: [],
};

describe('useReaderProgress', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        localStorage.clear();
    });

    it('is a no-op when documentId is falsy', () => {
        const { rerender: _rerender } = renderHook((props) => useReaderProgress(props), {
            initialProps: { ...baseProps, documentId: '' },
        });
        act(() => {
            vi.advanceTimersByTime(10_000);
        });
        expect(localStorage.length).toBe(0);

        // Even after a state change, no write happens.
        _rerender({ ...baseProps, documentId: '', page: 99 });
        act(() => {
            vi.advanceTimersByTime(10_000);
        });
        expect(localStorage.length).toBe(0);
    });

    it('persists the snapshot 3 s after the first state change', () => {
        renderHook((props) => useReaderProgress(props), {
            initialProps: { ...baseProps, page: 1, time: 0 },
        });

        // Just before the throttle window, nothing has been written.
        act(() => {
            vi.advanceTimersByTime(2999);
        });
        expect(localStorage.getItem(KEY)).toBeNull();

        // The throttle window fires; the snapshot is written.
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({ page: 1, time: 0 });
    });

    it('coalesces rapid changes into one write 3 s after the first (last-write-wins)', () => {
        const { rerender } = renderHook((props) => useReaderProgress(props), {
            initialProps: { ...baseProps, page: 1, time: 0 },
        });

        // Five rapid changes within the throttle window.
        rerender({ ...baseProps, page: 1, time: 1 });
        act(() => {
            vi.advanceTimersByTime(500);
        });
        rerender({ ...baseProps, page: 2, time: 5 });
        act(() => {
            vi.advanceTimersByTime(500);
        });
        rerender({ ...baseProps, page: 3, time: 12 });
        act(() => {
            vi.advanceTimersByTime(500);
        });
        rerender({ ...baseProps, page: 4, time: 20 });
        act(() => {
            vi.advanceTimersByTime(500);
        });
        rerender({ ...baseProps, page: 5, time: 30 });

        // Nothing has been written yet — the timer was set on the first
        // change and not reset by subsequent ones.
        expect(localStorage.getItem(KEY)).toBeNull();

        // 500 ms after the last change we're still inside the original 3 s
        // window from the first change; still no write.
        act(() => {
            vi.advanceTimersByTime(500);
        });
        expect(localStorage.getItem(KEY)).toBeNull();

        // 1 s after the last change the original 3 s timer fires and writes
        // the *final* values.
        act(() => {
            vi.advanceTimersByTime(500);
        });
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({
            page: 5,
            time: 30,
        });
    });

    it('starts a fresh throttle window after the previous write', () => {
        const { rerender } = renderHook((props) => useReaderProgress(props), {
            initialProps: { ...baseProps, page: 1, time: 0 },
        });

        // First write at t = 3000.
        act(() => {
            vi.advanceTimersByTime(3000);
        });
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({ page: 1, time: 0 });

        // A new state change starts a new 3 s window.
        rerender({ ...baseProps, page: 2, time: 4 });
        act(() => {
            vi.advanceTimersByTime(2999);
        });
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({ page: 1, time: 0 });
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({ page: 2, time: 4 });
    });

    it('persists the current state on pagehide', () => {
        const { rerender } = renderHook((props) => useReaderProgress(props), {
            initialProps: { ...baseProps, page: 7, time: 42 },
        });

        // Change state but stay well under the throttle window.
        rerender({ ...baseProps, page: 7, time: 43 });
        act(() => {
            vi.advanceTimersByTime(100);
        });
        expect(localStorage.getItem(KEY)).toBeNull();

        // Closing the tab flushes immediately.
        act(() => {
            window.dispatchEvent(new Event('pagehide'));
        });
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({
            page: 7,
            time: 43,
        });
    });

    it('persists the current state on visibilitychange to hidden', () => {
        const { rerender } = renderHook((props) => useReaderProgress(props), {
            initialProps: { ...baseProps, page: 2, time: 1 },
        });
        rerender({ ...baseProps, page: 2, time: 2 });

        // jsdom does not flip visibilityState automatically; the listener
        // only needs the event to fire.
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({
            page: 2,
            time: 2,
        });
    });

    it('switches the throttle to the new documentId without leaking the old snapshot', () => {
        const { rerender } = renderHook((props) => useReaderProgress(props), {
            initialProps: { ...baseProps, documentId: DOC, page: 1, time: 0 },
        });

        // Switch books inside the throttle window. The snapshot for DOC is
        // replaced by one for OTHER_DOC; the new document gets the write.
        rerender({ ...baseProps, documentId: OTHER_DOC, page: 9, time: 9 });

        // No write yet — the original 3 s timer is still running but the
        // snapshot it will invoke is now for OTHER_DOC.
        expect(localStorage.getItem(KEY)).toBeNull();
        expect(localStorage.getItem(OTHER_KEY)).toBeNull();

        act(() => {
            vi.advanceTimersByTime(3000);
        });
        expect(localStorage.getItem(KEY)).toBeNull();
        expect(JSON.parse(localStorage.getItem(OTHER_KEY))).toMatchObject({
            page: 9,
            time: 9,
        });
    });

    it('persists the pending snapshot on unmount', () => {
        const { rerender, unmount } = renderHook((props) => useReaderProgress(props), {
            initialProps: { ...baseProps, page: 3, time: 7 },
        });
        rerender({ ...baseProps, page: 3, time: 8 });
        act(() => {
            vi.advanceTimersByTime(100);
        });
        expect(localStorage.getItem(KEY)).toBeNull();

        unmount();
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({
            page: 3,
            time: 8,
        });
    });

    it('respects a custom interval', () => {
        const { rerender } = renderHook(
            (props) => useReaderProgress({ ...props, intervalMs: 500 }),
            {
                initialProps: { ...baseProps, page: 4, time: 0 },
            },
        );
        act(() => {
            vi.advanceTimersByTime(499);
        });
        expect(localStorage.getItem(KEY)).toBeNull();
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({ page: 4, time: 0 });

        // A new change arms a fresh 500 ms window.
        rerender({ ...baseProps, page: 5, time: 1, intervalMs: 500 });
        act(() => {
            vi.advanceTimersByTime(500);
        });
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({ page: 5, time: 1 });
    });

    it('exposes a manual flush that writes the current snapshot', () => {
        const { result, rerender } = renderHook((props) => useReaderProgress(props), {
            initialProps: { ...baseProps, page: 6, time: 0 },
        });
        rerender({ ...baseProps, page: 6, time: 11 });
        act(() => {
            result.current.flush();
        });
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({
            page: 6,
            time: 11,
        });

        // After a manual flush the next state change starts a new window.
        rerender({ ...baseProps, page: 6, time: 22 });
        act(() => {
            vi.advanceTimersByTime(2999);
        });
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({
            page: 6,
            time: 11,
        });
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({
            page: 6,
            time: 22,
        });
    });
});
