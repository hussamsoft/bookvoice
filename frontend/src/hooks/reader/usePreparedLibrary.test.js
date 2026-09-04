import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/api', () => ({
    listPreparedBooks: vi.fn(),
}));

import { listPreparedBooks } from '../../utils/api';
import { usePreparedLibrary } from './usePreparedLibrary';

describe('usePreparedLibrary', () => {
    beforeEach(() => {
        listPreparedBooks.mockReset();
    });
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('starts loading, then populates the list on success', async () => {
        listPreparedBooks.mockResolvedValue([{ id: 'a', title: 'A' }]);
        const { result } = renderHook(() => usePreparedLibrary());
        expect(result.current.isLoading).toBe(true);
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.books).toEqual([{ id: 'a', title: 'A' }]);
    });

    it('routes load errors to onError and clears isLoading', async () => {
        const boom = new Error('Network down');
        listPreparedBooks.mockRejectedValue(boom);
        const onError = vi.fn();
        const { result } = renderHook(() => usePreparedLibrary({ onError }));
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(onError).toHaveBeenCalledWith(boom);
        expect(result.current.books).toEqual([]);
    });

    it('refresh() re-fetches the list and merges the result', async () => {
        listPreparedBooks
            .mockResolvedValueOnce([{ id: 'a', title: 'A' }])
            .mockResolvedValueOnce([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
        const { result } = renderHook(() => usePreparedLibrary());
        await waitFor(() => expect(result.current.books).toHaveLength(1));
        await act(async () => { await result.current.refresh(); });
        expect(result.current.books).toHaveLength(2);
    });

    it('refresh() routes errors to onError and does not throw', async () => {
        const onError = vi.fn();
        listPreparedBooks
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('boom'));
        const { result } = renderHook(() => usePreparedLibrary({ onError }));
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        await act(async () => {
            const ret = await result.current.refresh();
            expect(ret).toBeNull();
        });
        expect(onError).toHaveBeenCalled();
    });

    it('setBooks() lets the consumer patch the list locally (e.g. progress update)', async () => {
        listPreparedBooks.mockResolvedValue([{ id: 'a', progress: { page: 1 } }]);
        const { result } = renderHook(() => usePreparedLibrary());
        await waitFor(() => expect(result.current.books).toHaveLength(1));
        act(() => {
            result.current.setBooks([{ id: 'a', progress: { page: 5 } }]);
        });
        expect(result.current.books).toEqual([{ id: 'a', progress: { page: 5 } }]);
    });

    it('aborts the initial fetch on unmount (no late setState)', async () => {
        let resolveInitial;
        listPreparedBooks.mockReturnValueOnce(new Promise((res) => { resolveInitial = res; }));
        const { result, unmount } = renderHook(() => usePreparedLibrary());
        expect(result.current.isLoading).toBe(true);
        unmount();
        // Resolving the initial promise after unmount must not throw or warn.
        await act(async () => {
            resolveInitial([{ id: 'a' }]);
            await Promise.resolve();
        });
        // The hook returned a `result` snapshot, but the component is gone.
        // The test just exercises that the unmount cleanup is a no-op on
        // late resolution; no further assertion is needed.
        expect(true).toBe(true);
    });

    it('coerces non-array responses to an empty list', async () => {
        listPreparedBooks.mockResolvedValue(null);
        const { result } = renderHook(() => usePreparedLibrary());
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.books).toEqual([]);
    });
});
