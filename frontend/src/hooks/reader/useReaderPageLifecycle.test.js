import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useReaderPageLifecycle } from './useReaderPageLifecycle';

const flushMicrotasks = async () => {
    // Two awaits to drain chained microtasks from the resolveContent
    // promise and the onContent callback that follows it.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
};

describe('useReaderPageLifecycle', () => {
    it('starts idle (isLoading=false)', () => {
        const { result } = renderHook(() => useReaderPageLifecycle({}));
        expect(result.current.isLoading).toBe(false);
        expect(typeof result.current.browsePage).toBe('function');
        expect(typeof result.current.loadPage).toBe('function');
    });

    it('browsePage resolves content and fires onContent with kind=browse', async () => {
        const resolveContent = vi.fn(async (page) => ({ text: `text for ${page}`, source: 'pdf' }));
        const onContent = vi.fn();
        const onBeforeLoad = vi.fn();
        const onError = vi.fn();
        const { result } = renderHook(() => useReaderPageLifecycle({
            totalPages: 10,
            resolveContent,
            onContent,
            onBeforeLoad,
            onError,
        }));

        act(() => result.current.browsePage(3));
        // The hook sets isLoading synchronously, before the awaiter runs.
        expect(result.current.isLoading).toBe(true);

        await flushMicrotasks();
        expect(resolveContent).toHaveBeenCalledWith(3);
        expect(onContent).toHaveBeenCalledWith('text for 3', 'pdf', {
            page: 3,
            kind: 'browse',
            autoplay: false,
        });
        // browsePage never invokes the load hook.
        expect(onBeforeLoad).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
        expect(result.current.isLoading).toBe(false);
    });

    it('loadPage invokes onBeforeLoad synchronously and fires onContent with kind=load', async () => {
        const resolveContent = vi.fn(async (_page) => ({ text: 'x', source: 'pdf' }));
        const onContent = vi.fn();
        const onBeforeLoad = vi.fn();
        const { result } = renderHook(() => useReaderPageLifecycle({
            resolveContent, onContent, onBeforeLoad,
        }));

        act(() => result.current.loadPage(7, { autoplay: true }));
        // onBeforeLoad fires synchronously, before the awaiter runs.
        expect(onBeforeLoad).toHaveBeenCalledTimes(1);

        await flushMicrotasks();
        expect(onContent).toHaveBeenCalledWith('x', 'pdf', {
            page: 7,
            kind: 'load',
            autoplay: true,
        });
    });

    it('clamps the page to [1, totalPages]', async () => {
        const resolveContent = vi.fn(async (page) => ({ text: String(page), source: 'pdf' }));
        const onContent = vi.fn();
        const { result } = renderHook(() => useReaderPageLifecycle({
            totalPages: 5,
            resolveContent,
            onContent,
        }));

        act(() => result.current.browsePage(99));
        await flushMicrotasks();
        expect(onContent).toHaveBeenCalledWith('5', 'pdf', expect.objectContaining({ page: 5 }));

        act(() => result.current.browsePage(-3));
        await flushMicrotasks();
        expect(onContent).toHaveBeenCalledWith('1', 'pdf', expect.objectContaining({ page: 1 }));

        act(() => result.current.browsePage(0));
        await flushMicrotasks();
        expect(onContent).toHaveBeenLastCalledWith('1', 'pdf', expect.objectContaining({ page: 1 }));

        // Non-numeric values are clamped to 1.
        act(() => result.current.browsePage('not-a-number'));
        await flushMicrotasks();
        expect(onContent).toHaveBeenLastCalledWith('1', 'pdf', expect.objectContaining({ page: 1 }));
    });

    it('drops a stale browse when a newer browse supersedes it', async () => {
        let resolveFirst;
        const firstPromise = new Promise((res) => { resolveFirst = () => res({ text: 'old', source: 'pdf' }); });
        const resolveContent = vi.fn()
            .mockImplementationOnce(() => firstPromise)
            .mockResolvedValueOnce({ text: 'new', source: 'pdf' });
        const onContent = vi.fn();
        const { result } = renderHook(() => useReaderPageLifecycle({
            totalPages: 10, resolveContent, onContent,
        }));

        // First browse — pending.
        act(() => result.current.browsePage(1));
        // Second browse — supersedes.
        act(() => result.current.browsePage(2));
        await flushMicrotasks();

        expect(onContent).toHaveBeenCalledTimes(1);
        expect(onContent).toHaveBeenLastCalledWith('new', 'pdf', expect.objectContaining({ page: 2 }));

        // Now force the first to resolve; it must be ignored.
        await act(async () => {
            resolveFirst();
            await Promise.resolve();
        });
        expect(onContent).toHaveBeenCalledTimes(1);
    });

    it('drops a stale load when a newer browse supersedes it', async () => {
        const resolveContent = vi.fn()
            .mockImplementationOnce(() => new Promise(() => { /* never resolves */ }))
            .mockResolvedValueOnce({ text: 'fresh', source: 'pdf' });
        const onContent = vi.fn();
        const onBeforeLoad = vi.fn();
        const { result } = renderHook(() => useReaderPageLifecycle({
            totalPages: 10, resolveContent, onContent, onBeforeLoad,
        }));

        // First load — pending forever.
        act(() => result.current.loadPage(5, { autoplay: true }));
        // Browse — supersedes the load.
        act(() => result.current.browsePage(8));
        await flushMicrotasks();

        expect(onContent).toHaveBeenCalledTimes(1);
        expect(onContent).toHaveBeenLastCalledWith('fresh', 'pdf', expect.objectContaining({
            page: 8,
            kind: 'browse',
        }));
        // onBeforeLoad was called for the load (only once), but the load's
        // onContent was dropped.
        expect(onBeforeLoad).toHaveBeenCalledTimes(1);
    });

    it('routes resolver errors to onError and clears isLoading', async () => {
        const boom = new Error('PDF is corrupt');
        const resolveContent = vi.fn(async () => { throw boom; });
        const onError = vi.fn();
        const onContent = vi.fn();
        const { result } = renderHook(() => useReaderPageLifecycle({
            resolveContent, onError, onContent,
        }));

        act(() => result.current.browsePage(4));
        await flushMicrotasks();

        expect(onError).toHaveBeenCalledWith(boom, { page: 4, kind: 'browse' });
        expect(onContent).not.toHaveBeenCalled();
        expect(result.current.isLoading).toBe(false);
    });

    it('drops a stale error from a superseded request', async () => {
        const oldErr = new Error('old failure');
        let rejectFirst;
        const firstPromise = new Promise((_, rej) => { rejectFirst = () => rej(oldErr); });
        const resolveContent = vi.fn()
            .mockImplementationOnce(() => firstPromise)
            .mockResolvedValueOnce({ text: 'new', source: 'pdf' });
        const onError = vi.fn();
        const onContent = vi.fn();
        const { result } = renderHook(() => useReaderPageLifecycle({
            totalPages: 10, resolveContent, onError, onContent,
        }));

        act(() => result.current.browsePage(1));
        act(() => result.current.browsePage(2));
        await flushMicrotasks();
        expect(onContent).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();

        // Now force the first to reject; the error must be ignored.
        await act(async () => {
            rejectFirst();
            await Promise.resolve();
        });
        expect(onError).not.toHaveBeenCalled();
    });

    it('picks up a new resolveContent via ref (book switch does not abort in-flight)', async () => {
        const oldResolve = vi.fn(async (page) => ({ text: `old-${page}`, source: 'pdf' }));
        const newResolve = vi.fn(async (page) => ({ text: `new-${page}`, source: 'pdf' }));
        const onContent = vi.fn();
        const { result, rerender } = renderHook((props) => useReaderPageLifecycle(props), {
            initialProps: { totalPages: 10, resolveContent: oldResolve, onContent },
        });

        // Switch the book before any submit.
        rerender({ totalPages: 10, resolveContent: newResolve, onContent });
        act(() => result.current.browsePage(5));
        await flushMicrotasks();

        // The new resolver is used; the old one is never called.
        expect(oldResolve).not.toHaveBeenCalled();
        expect(newResolve).toHaveBeenCalledWith(5);
        expect(onContent).toHaveBeenCalledWith('new-5', 'pdf', expect.objectContaining({ page: 5 }));
    });

    it('defaults autoplay to false when loadPage is called without options', async () => {
        const resolveContent = vi.fn(async (_page) => ({ text: 'x', source: 'pdf' }));
        const onContent = vi.fn();
        const { result } = renderHook(() => useReaderPageLifecycle({
            resolveContent, onContent,
        }));
        act(() => result.current.loadPage(1));
        await flushMicrotasks();
        expect(onContent).toHaveBeenCalledWith('x', 'pdf', expect.objectContaining({ autoplay: false }));
    });
});
