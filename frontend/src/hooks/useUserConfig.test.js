import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useUserConfig } from './useUserConfig';

vi.mock('../utils/api', () => ({
  getUserConfig: vi.fn(),
  saveUserConfig: vi.fn(),
}));

import { getUserConfig, saveUserConfig } from '../utils/api';

describe('useUserConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserConfig.mockResolvedValue({
      version: '1.7.0',
      config: { voice_id: 'Ryan', language_id: 'en' },
    });
    saveUserConfig.mockResolvedValue({ version: '1.7.0', config: {} });
  });

  it('loads config once and exposes it after the async fetch', async () => {
    const { result } = renderHook(() => useUserConfig());
    expect(result.current.config).toBeNull();

    await waitFor(() => {
      expect(result.current.config).toEqual({ voice_id: 'Ryan', language_id: 'en' });
    });
    expect(result.current.version).toBe('1.7.0');
    expect(getUserConfig).toHaveBeenCalledTimes(1);
  });

  it('falls back to empty config when load fails', async () => {
    getUserConfig.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useUserConfig());
    await waitFor(() => {
      expect(result.current.config).toEqual({});
    });
  });

  it('serializes rapid successive updates so the last value wins', async () => {
    let resolveFirst;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const calls = [];
    saveUserConfig.mockImplementation((partial) => {
      calls.push({ ...partial });
      if (calls.length === 1) {
        return first.then(() => ({ version: '1.7.0', config: partial }));
      }
      return Promise.resolve({ version: '1.7.0', config: partial });
    });

    const { result } = renderHook(() => useUserConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());

    let p1;
    let p2;
    let p3;
    act(() => {
      p1 = result.current.updateConfig({ voice_id: 'A' });
      p2 = result.current.updateConfig({ voice_id: 'B' });
      p3 = result.current.updateConfig({ voice_id: 'C' });
    });

    // Optimistic local state already shows the latest value.
    expect(result.current.config.voice_id).toBe('C');

    await act(async () => {
      resolveFirst();
      await Promise.all([p1, p2, p3]);
    });

    // First save drains A (or A+later coalesced). Last save must persist C.
    const lastCall = calls[calls.length - 1];
    expect(lastCall.voice_id).toBe('C');
    // No later call may re-persist an older voice over C.
    const afterC = calls.slice(calls.findIndex((c) => c.voice_id === 'C') + 1);
    expect(afterC.every((c) => c.voice_id === 'C' || c.voice_id === undefined)).toBe(true);
  });

  it('surfaces a rejected save via saveError and rolls optimistic UI back', async () => {
    saveUserConfig.mockRejectedValueOnce(new Error('disk full'));
    const { result } = renderHook(() => useUserConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());

    await act(async () => {
      const rejected = result.current.updateConfig({ language_id: 'ar' });
      await expect(rejected).rejects.toThrow('disk full');
    });

    await waitFor(() => {
      expect(result.current.saveError).toBe('disk full');
    });
    // Rolled back to last committed value (en), not left stuck on ar.
    expect(result.current.config.language_id).toBe('en');
  });
});
