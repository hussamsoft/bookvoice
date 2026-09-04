import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useServerPageText } from './useServerPageText';

vi.mock('../../utils/api', () => ({
    getBookPage: vi.fn(),
}));

import { getBookPage } from '../../utils/api';

describe('useServerPageText', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('fetches a page once and serves later reads from the cache', async () => {
        getBookPage.mockResolvedValue({ page: 2, text: '  hello world  ' });
        const { result } = renderHook(() => useServerPageText({ totalPages: 5 }));

        await expect(result.current.fetchPage('b1', 2)).resolves.toBe('hello world');
        await expect(result.current.fetchPage('b1', 2)).resolves.toBe('hello world');
        expect(getBookPage).toHaveBeenCalledTimes(1);
        expect(getBookPage).toHaveBeenCalledWith('b1', 2);
    });

    it('throws a page-scoped error when the server page has no text', async () => {
        getBookPage.mockResolvedValue({ page: 3, text: '   ' });
        const { result } = renderHook(() => useServerPageText({ totalPages: 5 }));
        await expect(result.current.fetchPage('b1', 3)).rejects.toThrow('No text found on page 3.');
    });

    it('keys the cache by book id so a second book never sees stale pages', async () => {
        getBookPage.mockImplementation(async (bookId, page) => ({
            page,
            text: `text of ${bookId} ${page}`,
        }));
        const { result } = renderHook(() => useServerPageText({ totalPages: 5 }));
        await expect(result.current.fetchPage('b1', 1)).resolves.toBe('text of b1 1');
        await expect(result.current.fetchPage('b2', 1)).resolves.toBe('text of b2 1');
        expect(getBookPage).toHaveBeenCalledTimes(2);
    });

    it('scans wrap-around from startPage and returns the first match', async () => {
        getBookPage.mockImplementation(async (bookId, page) => ({
            page,
            text: page === 7 ? 'the treasure is here' : `page ${page} filler`,
        }));
        const { result } = renderHook(() => useServerPageText({ totalPages: 10 }));

        await expect(result.current.findText('b1', 'treasure', 2)).resolves.toBe(7);
        // Wrap-around: searching from page 9 finds the page-7 match only
        // after wrapping past 10 → 1.
        await expect(result.current.findText('b1', 'treasure', 9)).resolves.toBe(7);
    });

    it('skips unreadable pages instead of failing the scan', async () => {
        getBookPage.mockImplementation(async (bookId, page) => (
            page === 4 ? Promise.reject(new Error('boom')) : { page, text: `findme ${page}` }
        ));
        const { result } = renderHook(() => useServerPageText({ totalPages: 6 }));
        await expect(result.current.findText('b1', 'findme', 1)).resolves.toBe(1);
    });

    it('returns null when there is no query, book, or page count', async () => {
        const { result } = renderHook(() => useServerPageText({ totalPages: 0 }));
        await expect(result.current.findText('b1', 'x', 1)).resolves.toBeNull();
    });

    it('clear drops the cached pages', async () => {
        getBookPage.mockResolvedValue({ page: 1, text: 'once' });
        const { result } = renderHook(() => useServerPageText({ totalPages: 2 }));
        await result.current.fetchPage('b1', 1);
        result.current.clear();
        await result.current.fetchPage('b1', 1);
        expect(getBookPage).toHaveBeenCalledTimes(2);
    });

    it('warms pages with bounded concurrency before scanning', async () => {
        let inFlight = 0;
        let peak = 0;
        getBookPage.mockImplementation(async (_bookId, page) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 0));
            inFlight -= 1;
            return { page, text: `p${page}` };
        });
        const { result } = renderHook(() => useServerPageText({ totalPages: 9 }));
        await result.current.findText('b1', 'p9', 9);
        expect(peak).toBeLessThanOrEqual(3);
    });
});
