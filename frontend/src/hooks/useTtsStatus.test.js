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
});
