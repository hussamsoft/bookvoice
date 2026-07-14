import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWordHighlight } from './useWordHighlight';

function ref(current) {
    return { current };
}

describe('useWordHighlight page ownership', () => {
    it('tracks narration time without highlighting an independently browsed page', () => {
        const root = document.createElement('div');
        root.innerHTML = '<div class="react-pdf__Page__textContent"><span>Hello world</span></div>';
        const currentWordRef = ref(-1);
        const viewPageRef = ref(2);
        const audioPageRef = ref(1);
        const setCurrentWord = vi.fn();

        const { result } = renderHook(() =>
            useWordHighlight({
                containerRef: ref(root),
                langRef: ref('en'),
                audioRef: ref(null),
                setCurrentWord,
                currentWordRef,
                pageWordsRef: ref(['Hello', 'world']),
                wordTimesRef: ref([0, 1]),
                wordEndsRef: ref([0.8, 1.8]),
                audioTimeOffsetRef: ref(0),
                viewPageRef,
                audioPageRef,
            })
        );

        act(() => {
            result.current.rebindWordSpans();
            result.current.syncHighlightAt(0.2);
        });

        expect(currentWordRef.current).toBe(0);
        expect(root.querySelector('.highlight-active')).toBeNull();

        viewPageRef.current = 1;
        act(() => result.current.syncHighlightAt(0.2));
        expect(root.querySelector('.highlight-active')).not.toBeNull();
    });
});
