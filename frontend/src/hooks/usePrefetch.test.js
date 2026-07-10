import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePrefetch } from './usePrefetch';

describe('usePrefetch', () => {
  afterEach(() => vi.useRealTimers());

  it('does not cache a narration that completes after cancellation', async () => {
    vi.useFakeTimers();
    let resolveNarration;
    const narration = new Promise((resolve) => { resolveNarration = resolve; });
    const cache = {
      hasReady: vi.fn(() => false),
      retainPageWindow: vi.fn(),
      set: vi.fn(),
    };
    const { result } = renderHook(() => usePrefetch({
      cacheRef: { current: cache },
      activeVoiceRef: { current: 'voice' },
      langRef: { current: 'en' },
      modelReady: true,
      isGeneratingRef: { current: false },
      isPlayingRef: { current: false },
      preparePageText: vi.fn(async () => 'next page'),
      narratePage: vi.fn(() => narration),
      setPrefetchHint: vi.fn(),
    }));

    act(() => result.current.schedulePrefetch(1, 3));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => result.current.cancelPrefetch());
    await act(async () => { resolveNarration({ status: 'ready', audioUrl: '/next.wav' }); });

    expect(cache.set).not.toHaveBeenCalled();
  });
});
