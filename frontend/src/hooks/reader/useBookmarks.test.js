import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useBookmarks } from './useBookmarks';

describe('useBookmarks', () => {
    it('starts empty when no initial list is given', () => {
        const { result } = renderHook(() => useBookmarks());
        expect(result.current.bookmarks).toEqual([]);
    });

    it('seeds from the initial list (the consumer is responsible for sorting)', () => {
        // The hook does not re-sort the *initial* list — the consumer can
        // pass a pre-sorted list, or call `set(next)` to normalise.
        const { result } = renderHook(() => useBookmarks({ initial: [2, 5, 7] }));
        expect(result.current.bookmarks).toEqual([2, 5, 7]);
    });

    it('set() normalises the initial list when it is not sorted', () => {
        // The consumer can use `set()` to fix up a list that arrives in a
        // different order (e.g. a server response).
        const { result } = renderHook(() => useBookmarks({ initial: [7, 2, 5] }));
        act(() => result.current.set(result.current.bookmarks));
        expect(result.current.bookmarks).toEqual([2, 5, 7]);
    });

    it('toggles a page in (add)', () => {
        const { result } = renderHook(() => useBookmarks({ initial: [2, 7] }));
        act(() => result.current.toggle(5));
        expect(result.current.bookmarks).toEqual([2, 5, 7]);
    });

    it('toggles a page out (remove)', () => {
        const { result } = renderHook(() => useBookmarks({ initial: [2, 5, 7] }));
        act(() => result.current.toggle(5));
        expect(result.current.bookmarks).toEqual([2, 7]);
    });

    it('treats toggle of an absent page as an add', () => {
        const { result } = renderHook(() => useBookmarks());
        act(() => result.current.toggle(9));
        expect(result.current.bookmarks).toEqual([9]);
    });

    it('treats toggle of the current page as a remove', () => {
        const { result } = renderHook(() => useBookmarks({ initial: [9] }));
        act(() => result.current.toggle(9));
        expect(result.current.bookmarks).toEqual([]);
    });

    it('set() replaces the list, normalises and sorts', () => {
        const { result } = renderHook(() => useBookmarks({ initial: [1] }));
        act(() => result.current.set([5, 2, 5, -1, 0, 3.7, 11]));
        // Non-positive and non-finite values are dropped; dupes collapse; order ascending.
        expect(result.current.bookmarks).toEqual([2, 3, 5, 11]);
    });

    it('set() ignores non-array input', () => {
        const { result } = renderHook(() => useBookmarks({ initial: [1, 2] }));
        act(() => result.current.set(null));
        expect(result.current.bookmarks).toEqual([1, 2]);
    });

    it('clear() empties the list', () => {
        const { result } = renderHook(() => useBookmarks({ initial: [1, 2, 3] }));
        act(() => result.current.clear());
        expect(result.current.bookmarks).toEqual([]);
    });

    it('isBookmarked reflects the current state', () => {
        const { result } = renderHook(() => useBookmarks({ initial: [4, 9] }));
        expect(result.current.isBookmarked(4)).toBe(true);
        expect(result.current.isBookmarked(9)).toBe(true);
        expect(result.current.isBookmarked(3)).toBe(false);
        act(() => result.current.toggle(3));
        expect(result.current.isBookmarked(3)).toBe(true);
    });

    it('clamps non-integer and non-positive toggle inputs to page 1 (matches the pure helper)', () => {
        const { result } = renderHook(() => useBookmarks());
        // 0, -1, and 0.7 all round to page 1; only the first one adds, the
        // rest are no-ops because page 1 is already in the list.
        act(() => result.current.toggle(0));
        act(() => result.current.toggle(-1));
        act(() => result.current.toggle(0.7));
        expect(result.current.bookmarks).toEqual([1]);
        act(() => result.current.toggle(2.7));
        expect(result.current.bookmarks).toEqual([1, 2]);
    });
});
