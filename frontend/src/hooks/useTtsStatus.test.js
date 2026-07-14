import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTtsStatus } from './useTtsStatus';

vi.mock('../utils/api', () => ({
  getTtsStatus: vi.fn(),
  reloadTtsModel: vi.fn(),
}));

import { getTtsStatus, reloadTtsModel } from '../utils/api';

describe('useTtsStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retryLoad clears displayed error and resumes polling', async () => {
    getTtsStatus
      .mockResolvedValueOnce({
        status: 'error',
        detail: 'CUDA OOM',
        device: 'cuda',
        cuda: true,
      })
      .mockResolvedValue({
        status: 'loading',
        detail: 'Reloading model...',
        device: 'cuda',
        cuda: true,
        elapsed_s: 1,
      });
    reloadTtsModel.mockResolvedValue({ status: 'loading', detail: 'Reloading model...' });

    const { result } = renderHook(() => useTtsStatus());

    // Allow first poll to settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.modelError).toBe('CUDA OOM');

    await act(async () => {
      await result.current.retryLoad();
    });

    expect(result.current.modelError).toBeNull();
    expect(result.current.modelStatusDetail).toMatch(/Reload/i);
    expect(reloadTtsModel).toHaveBeenCalledTimes(1);
    // Polling restarted (epoch bump) — status fetch ran again after reload.
    expect(getTtsStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces a connection error after repeated poll failures', async () => {
    vi.useFakeTimers();
    getTtsStatus.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useTtsStatus());

    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    }

    expect(result.current.modelError).toMatch(/Cannot reach the reading engine/i);
    expect(result.current.modelReady).toBe(false);
  });
});
