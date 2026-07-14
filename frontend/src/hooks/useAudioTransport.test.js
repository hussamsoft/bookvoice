import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAudioTransport } from './useAudioTransport';

function audioFixture() {
  const audio = document.createElement('audio');
  Object.defineProperty(audio, 'duration', { configurable: true, value: 100 });
  audio.play = vi.fn(async () => audio.dispatchEvent(new Event('play')));
  audio.pause = vi.fn(() => audio.dispatchEvent(new Event('pause')));
  return audio;
}

describe('useAudioTransport', () => {
  it('clamps seeks and cycles playback speed', () => {
    const audio = audioFixture();
    const { result } = renderHook(() => useAudioTransport({ current: audio }));

    act(() => result.current.seekTo(140));
    expect(audio.currentTime).toBe(100);
    act(() => result.current.seekTo(-5));
    expect(audio.currentTime).toBe(0);

    act(() => result.current.cycleRate());
    expect(audio.playbackRate).toBe(1.25);
    expect(result.current.playbackRate).toBe(1.25);
  });

  it('reports play and pause from the media element', async () => {
    const audio = audioFixture();
    const { result } = renderHook(() => useAudioTransport({ current: audio }));

    await act(async () => result.current.toggle());
    expect(result.current.isPlaying).toBe(true);
    act(() => audio.pause());
    expect(result.current.isPlaying).toBe(false);
  });

  it('uses an external logical timeline for chunked audio', () => {
    const audio = audioFixture();
    audio.currentTime = 2;
    const timelineRef = {
      current: {
        getCurrentTime: (media) => 10 + media.currentTime,
        getDuration: () => 30,
        seekTo: vi.fn((seconds, media) => {
          media.currentTime = seconds - 10;
          return seconds;
        }),
      },
    };
    const { result } = renderHook(() => useAudioTransport({ current: audio }, timelineRef));

    act(() => audio.dispatchEvent(new Event('timeupdate')));
    expect(result.current.currentTime).toBe(12);
    expect(result.current.duration).toBe(30);

    act(() => result.current.seekTo(20));
    expect(timelineRef.current.seekTo).toHaveBeenCalledWith(20, audio);
    expect(result.current.currentTime).toBe(20);

    act(() => result.current.skipBy(5));
    expect(timelineRef.current.seekTo).toHaveBeenLastCalledWith(25, audio);
  });

  it('does not leak the previous media duration into an empty new timeline', () => {
    const audio = audioFixture();
    const timelineRef = {
      current: {
        getCurrentTime: () => 0,
        getDuration: () => 0,
      },
    };

    const { result } = renderHook(() => useAudioTransport({ current: audio }, timelineRef));

    expect(result.current.currentTime).toBe(0);
    expect(result.current.duration).toBe(0);
  });
});
