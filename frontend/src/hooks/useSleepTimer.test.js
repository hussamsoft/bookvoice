import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SLEEP_END_OF_CHAPTER, useSleepTimer } from './useSleepTimer';

describe('useSleepTimer', () => {
  afterEach(() => vi.useRealTimers());

  it('is off by default and reports inactive', () => {
    const { result } = renderHook(() => useSleepTimer({ playing: true }));
    expect(result.current.minutes).toBeNull();
    expect(result.current.active).toBe(false);
    expect(result.current.remainingMs).toBeNull();
  });

  it('counts down only while playing and freezes while paused', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ play }) => useSleepTimer({ playing: play }), {
      initialProps: { play: false },
    });
    act(() => result.current.setMinutes(5));
    expect(result.current.remainingMs).toBe(300000);

    // Paused: wall-clock time passes but the countdown stays frozen.
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.remainingMs).toBe(300000);

    // Playing: the frozen remainder counts down.
    rerender({ play: true });
    act(() => vi.advanceTimersByTime(10000));
    expect(result.current.remainingMs).toBeLessThanOrEqual(290000);

    rerender({ play: false });
    const frozen = result.current.remainingMs;
    act(() => vi.advanceTimersByTime(30000));
    expect(result.current.remainingMs).toBe(frozen);

    rerender({ play: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.remainingMs).toBeLessThan(frozen);
  });

  it('fires the expiry callback once and resets to Off', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result } = renderHook(() => useSleepTimer({ playing: true, onExpire }));
    act(() => result.current.setMinutes(5));

    act(() => vi.advanceTimersByTime(300000));
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(false);
    expect(result.current.minutes).toBeNull();

    act(() => vi.advanceTimersByTime(60000));
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('cancel stops an armed timer without firing', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const { result } = renderHook(() => useSleepTimer({ playing: true, onExpire }));
    act(() => result.current.setMinutes(5));
    act(() => result.current.cancel());
    expect(result.current.active).toBe(false);

    act(() => vi.advanceTimersByTime(600000));
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('end-of-chapter mode fires once per arming', () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useSleepTimer({ playing: true, onExpire }));
    act(() => result.current.setMinutes(SLEEP_END_OF_CHAPTER));
    expect(result.current.active).toBe(true);

    act(() => result.current.notifyPageEnded());
    act(() => result.current.notifyPageEnded());
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(false);

    act(() => result.current.notifyPageEnded());
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('ignores end-of-chapter notifications while a minute timer runs', () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useSleepTimer({ playing: true, onExpire }));
    act(() => result.current.setMinutes(10));
    act(() => result.current.notifyPageEnded());
    expect(onExpire).not.toHaveBeenCalled();
    expect(result.current.active).toBe(true);
  });
});
