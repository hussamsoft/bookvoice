import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReaderSearch } from './useReaderSearch';

const baseProps = {
    findInDocument: null,
    currentPage: 1,
    totalPages: 10,
    debounceMs: 0,
};

describe('useReaderSearch', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('starts idle with no result and no error', () => {
        const { result } = renderHook((props) => useReaderSearch(props), {
            initialProps: baseProps,
        });
        expect(result.current.isSearching).toBe(false);
        expect(result.current.result).toBeNull();
        expect(result.current.error).toBeNull();
    });

    it('is a no-op for an empty query', async () => {
        const find = vi.fn();
        const { result } = renderHook((props) => useReaderSearch(props), {
            initialProps: { ...baseProps, findInDocument: find },
        });
        act(() => result.current.submit('   '));
        expect(find).not.toHaveBeenCalled();
        expect(result.current.isSearching).toBe(false);
        expect(result.current.result).toBeNull();
    });

    it('is a no-op when the book has no pages', () => {
        const find = vi.fn();
        const { result } = renderHook((props) => useReaderSearch(props), {
            initialProps: { ...baseProps, findInDocument: find, totalPages: 0 },
        });
        act(() => result.current.submit('needle'));
        expect(find).not.toHaveBeenCalled();
        expect(result.current.isSearching).toBe(false);
    });

    it('returns the found page when the finder matches', async () => {
        const find = vi.fn(async () => 7);
        const { result } = renderHook((props) => useReaderSearch(props), {
            initialProps: { ...baseProps, findInDocument: find, currentPage: 3 },
        });

        act(() => result.current.submit('needle'));
        // The finder is async; the result has not arrived yet.
        expect(result.current.isSearching).toBe(true);
        expect(result.current.result).toBeNull();

        await act(async () => {
            await vi.runAllTimersAsync();
        });
        expect(find).toHaveBeenCalledWith('needle', 4);
        expect(result.current.isSearching).toBe(false);
        expect(result.current.result).toBe(7);
        expect(result.current.error).toBeNull();
    });

    it('returns null when the finder reports no match', async () => {
        const find = vi.fn(async () => null);
        const { result } = renderHook((props) => useReaderSearch(props), {
            initialProps: { ...baseProps, findInDocument: find },
        });

        act(() => result.current.submit('needle'));
        await act(async () => {
            await vi.runAllTimersAsync();
        });
        expect(result.current.result).toBeNull();
        expect(result.current.isSearching).toBe(false);
    });

    it('captures errors from the finder', async () => {
        const boom = new Error('OCR engine is offline');
        const find = vi.fn(async () => { throw boom; });
        const { result } = renderHook((props) => useReaderSearch(props), {
            initialProps: { ...baseProps, findInDocument: find },
        });

        act(() => result.current.submit('needle'));
        await act(async () => {
            await vi.runAllTimersAsync();
        });
        expect(result.current.error).toBe(boom);
        expect(result.current.result).toBeNull();
        expect(result.current.isSearching).toBe(false);
    });

    it('drops a stale submit when a newer submit resolves first', async () => {
        // The first finder call returns a promise that never resolves; the
        // second call resolves immediately. The first submit must be ignored
        // even if a late resolution is forced.
        let firstResolve;
        const firstPromise = new Promise((res) => { firstResolve = () => res(null); });
        const find = vi.fn()
            .mockImplementationOnce(() => firstPromise)
            .mockResolvedValueOnce(5);
        const { result } = renderHook((props) => useReaderSearch(props), {
            initialProps: { ...baseProps, findInDocument: find, currentPage: 1 },
        });

        // First submit — pending, never resolves on its own.
        act(() => result.current.submit('first'));
        // Second submit (same currentPage, so still startPage=2 but the
        // finder is called a second time) — resolves to 5.
        act(() => result.current.submit('second'));

        await act(async () => {
            await vi.runAllTimersAsync();
        });
        expect(result.current.result).toBe(5);

        // Now force the first to resolve with null; the stale submit must
        // be ignored.
        await act(async () => {
            firstResolve();
            await Promise.resolve();
        });
        expect(result.current.result).toBe(5);
        expect(result.current.isSearching).toBe(false);
    });

    it('debounces the finder by `debounceMs` when set', async () => {
        const find = vi.fn(async () => 9);
        const { result } = renderHook((props) => useReaderSearch(props), {
            initialProps: { ...baseProps, findInDocument: find, debounceMs: 200 },
        });

        act(() => result.current.submit('needle'));
        // Before the debounce window, the finder has not been called.
        expect(find).not.toHaveBeenCalled();
        expect(result.current.isSearching).toBe(false);

        // Just before the window expires.
        act(() => { vi.advanceTimersByTime(199); });
        expect(find).not.toHaveBeenCalled();

        // The window expires and the finder runs.
        act(() => { vi.advanceTimersByTime(1); });
        expect(find).toHaveBeenCalledWith('needle', 2);
        await act(async () => {
            await vi.runAllTimersAsync();
        });
        expect(result.current.result).toBe(9);
    });

    it('resets state and cancels a pending debounce', async () => {
        const find = vi.fn(async () => 9);
        const { result } = renderHook((props) => useReaderSearch(props), {
            initialProps: { ...baseProps, findInDocument: find, debounceMs: 200 },
        });

        act(() => result.current.submit('needle'));
        act(() => result.current.reset());
        expect(result.current.result).toBeNull();
        expect(result.current.error).toBeNull();
        expect(result.current.isSearching).toBe(false);

        // Advance well past the debounce window; the finder must not run.
        act(() => { vi.advanceTimersByTime(500); });
        expect(find).not.toHaveBeenCalled();
    });

    it('clears a prior result when a new submit returns null', async () => {
        const firstFind = vi.fn(async () => 4);
        const secondFind = vi.fn(async () => null);
        const { result, rerender } = renderHook((props) => useReaderSearch(props), {
            initialProps: { ...baseProps, findInDocument: firstFind },
        });

        act(() => result.current.submit('a'));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(result.current.result).toBe(4);

        // Swap the finder and submit again. The result should clear to null.
        rerender({ ...baseProps, findInDocument: secondFind });
        act(() => result.current.submit('b'));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(result.current.result).toBeNull();
    });

    it('treats a missing finder as a no-match (no crash)', async () => {
        const { result } = renderHook((props) => useReaderSearch(props), {
            initialProps: { ...baseProps, findInDocument: null },
        });

        act(() => result.current.submit('needle'));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(result.current.result).toBeNull();
        expect(result.current.isSearching).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it('uses the latest finder after a book switch (ref-based)', async () => {
        const oldFind = vi.fn(async () => 3);
        const newFind = vi.fn(async () => 9);
        const { result, rerender } = renderHook((props) => useReaderSearch(props), {
            initialProps: { ...baseProps, findInDocument: oldFind },
        });

        // The book is swapped before any submit; the ref pattern means the
        // next submit uses the new finder.
        rerender({ ...baseProps, findInDocument: newFind });
        act(() => result.current.submit('needle'));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(oldFind).not.toHaveBeenCalled();
        expect(newFind).toHaveBeenCalledWith('needle', 2);
        expect(result.current.result).toBe(9);
    });

    it('cancels a pending debounce on unmount', () => {
        const find = vi.fn(async () => 9);
        const { result, unmount } = renderHook((props) => useReaderSearch(props), {
            initialProps: { ...baseProps, findInDocument: find, debounceMs: 200 },
        });
        act(() => result.current.submit('needle'));
        unmount();
        act(() => { vi.advanceTimersByTime(500); });
        expect(find).not.toHaveBeenCalled();
    });
});
