import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePageResume } from './usePageResume';

describe('usePageResume', () => {
    it('does not show the dialog when the user is on the narrated page', () => {
        const { result } = renderHook(() => usePageResume({
            currentPage: 5,
            audioPage: 5,
            hasAudio: true,
        }));
        expect(result.current.showChoice).toBe(false);
    });

    it('does not show the dialog for a one-page drift (the 1-page-window rule)', () => {
        // The plan's §2.3.2: show only when the user has gone *more than*
        // one page away. A drift of 1 page is the safe default.
        const { result: r1 } = renderHook(() => usePageResume({
            currentPage: 6,
            audioPage: 5,
            hasAudio: true,
        }));
        expect(r1.current.showChoice).toBe(false);

        const { result: r2 } = renderHook(() => usePageResume({
            currentPage: 4,
            audioPage: 5,
            hasAudio: true,
        }));
        expect(r2.current.showChoice).toBe(false);
    });

    it('shows the dialog when the user has navigated more than one page away', () => {
        const { result: r1 } = renderHook(() => usePageResume({
            currentPage: 9,
            audioPage: 5,
            hasAudio: true,
        }));
        expect(r1.current.showChoice).toBe(true);

        const { result: r2 } = renderHook(() => usePageResume({
            currentPage: 1,
            audioPage: 5,
            hasAudio: true,
        }));
        expect(r2.current.showChoice).toBe(true);
    });

    it('does not show the dialog when there is no audio to resume', () => {
        const { result: r1 } = renderHook(() => usePageResume({
            currentPage: 9,
            audioPage: null,
            hasAudio: false,
        }));
        expect(r1.current.showChoice).toBe(false);

        const { result: r2 } = renderHook(() => usePageResume({
            currentPage: 9,
            audioPage: undefined,
            hasAudio: false,
        }));
        expect(r2.current.showChoice).toBe(false);
    });

    it('does not show the dialog when hasAudio is explicitly false (even with audioPage)', () => {
        const { result } = renderHook(() => usePageResume({
            currentPage: 12,
            audioPage: 3,
            hasAudio: false,
        }));
        expect(result.current.showChoice).toBe(false);
    });

    it('treats non-numeric page values as no-audio (defensive)', () => {
        const { result: r1 } = renderHook(() => usePageResume({
            currentPage: NaN,
            audioPage: 5,
            hasAudio: true,
        }));
        expect(r1.current.showChoice).toBe(false);

        const { result: r2 } = renderHook(() => usePageResume({
            currentPage: 5,
            audioPage: 'not-a-page',
            hasAudio: true,
        }));
        expect(r2.current.showChoice).toBe(false);
    });

    it('resume() invokes onResume and hides the dialog', () => {
        const onResume = vi.fn();
        const { result } = renderHook(() => usePageResume({
            currentPage: 9,
            audioPage: 5,
            hasAudio: true,
            onResume,
        }));
        expect(result.current.showChoice).toBe(true);
        act(() => result.current.resume());
        expect(onResume).toHaveBeenCalledTimes(1);
        expect(result.current.showChoice).toBe(false);
    });

    it('startFresh() invokes onStartFresh and hides the dialog', () => {
        const onStartFresh = vi.fn();
        const { result } = renderHook(() => usePageResume({
            currentPage: 9,
            audioPage: 5,
            hasAudio: true,
            onStartFresh,
        }));
        act(() => result.current.startFresh());
        expect(onStartFresh).toHaveBeenCalledTimes(1);
        expect(result.current.showChoice).toBe(false);
    });

    it('dismiss() hides the dialog without firing either action', () => {
        const onResume = vi.fn();
        const onStartFresh = vi.fn();
        const { result } = renderHook(() => usePageResume({
            currentPage: 9,
            audioPage: 5,
            hasAudio: true,
            onResume,
            onStartFresh,
        }));
        act(() => result.current.dismiss());
        expect(onResume).not.toHaveBeenCalled();
        expect(onStartFresh).not.toHaveBeenCalled();
        expect(result.current.showChoice).toBe(false);
    });

    it('picks up the latest onResume / onStartFresh via ref (no callback churn)', () => {
        const first = vi.fn();
        const second = vi.fn();
        const { result, rerender } = renderHook((props) => usePageResume(props), {
            initialProps: {
                currentPage: 9,
                audioPage: 5,
                hasAudio: true,
                onResume: first,
            },
        });
        rerender({
            currentPage: 9,
            audioPage: 5,
            hasAudio: true,
            onResume: second,
        });
        act(() => result.current.resume());
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });
});
