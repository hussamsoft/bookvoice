import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useReaderTransport } from './useReaderTransport';

function audioFixture({ currentTime = 5, duration = 30 } = {}) {
    const audio = document.createElement('audio');
    Object.defineProperty(audio, 'duration', { configurable: true, value: duration });
    audio.currentTime = currentTime;
    return audio;
}

describe('useReaderTransport', () => {
    it('exposes the same shape as useAudioTransport plus timeline controls', () => {
        const audioRef = { current: audioFixture() };
        const { result } = renderHook(() => useReaderTransport(audioRef));
        expect(result.current).toHaveProperty('isPlaying');
        expect(result.current).toHaveProperty('currentTime');
        expect(result.current).toHaveProperty('duration');
        expect(result.current).toHaveProperty('playbackRate');
        expect(result.current).toHaveProperty('mediaError');
        expect(typeof result.current.toggle).toBe('function');
        expect(typeof result.current.seekTo).toBe('function');
        expect(typeof result.current.skipBy).toBe('function');
        expect(typeof result.current.cycleRate).toBe('function');
        expect(typeof result.current.setRate).toBe('function');
        expect(typeof result.current.refresh).toBe('function');
        expect(typeof result.current.installPlaylistTimeline).toBe('function');
        expect(typeof result.current.clearPlaylistTimeline).toBe('function');
    });

    it('starts with no playlist timeline (currentTime falls back to audio element)', () => {
        const audio = audioFixture({ currentTime: 12.5, duration: 60 });
        const audioRef = { current: audio };
        const { result } = renderHook(() => useReaderTransport(audioRef));
        act(() => result.current.refresh());
        expect(result.current.currentTime).toBe(12.5);
        expect(result.current.duration).toBe(60);
    });

    it('installPlaylistTimeline switches currentTime / duration to the timeline', () => {
        const audio = audioFixture({ currentTime: 12.5, duration: 60 });
        const audioRef = { current: audio };
        const timeline = {
            getCurrentTime: (media) => (media === audio ? 42 : 0),
            getDuration: () => 180,
            seekTo: vi.fn(),
        };
        const { result } = renderHook(() => useReaderTransport(audioRef));
        act(() => result.current.installPlaylistTimeline(timeline));
        act(() => result.current.refresh());
        expect(result.current.currentTime).toBe(42);
        expect(result.current.duration).toBe(180);
    });

    it('installPlaylistTimeline(null) is equivalent to clearPlaylistTimeline', () => {
        const audio = audioFixture({ currentTime: 12.5, duration: 60 });
        const audioRef = { current: audio };
        const timeline = {
            getCurrentTime: () => 99,
            getDuration: () => 999,
            seekTo: vi.fn(),
        };
        const { result } = renderHook(() => useReaderTransport(audioRef));
        act(() => result.current.installPlaylistTimeline(timeline));
        act(() => result.current.refresh());
        expect(result.current.currentTime).toBe(99);

        act(() => result.current.installPlaylistTimeline(null));
        act(() => result.current.refresh());
        expect(result.current.currentTime).toBe(12.5);
    });

    it('clearPlaylistTimeline restores the raw audio element values', () => {
        const audio = audioFixture({ currentTime: 7, duration: 30 });
        const audioRef = { current: audio };
        const timeline = {
            getCurrentTime: () => 1000,
            getDuration: () => 1000,
            seekTo: vi.fn(),
        };
        const { result } = renderHook(() => useReaderTransport(audioRef));
        act(() => result.current.installPlaylistTimeline(timeline));
        act(() => result.current.refresh());
        expect(result.current.duration).toBe(1000);

        act(() => result.current.clearPlaylistTimeline());
        act(() => result.current.refresh());
        expect(result.current.duration).toBe(30);
        expect(result.current.currentTime).toBe(7);
    });

    it('picks up the latest timeline on the next refresh (no re-render needed)', () => {
        const audio = audioFixture({ currentTime: 5, duration: 20 });
        const audioRef = { current: audio };
        const { result } = renderHook(() => useReaderTransport(audioRef));
        act(() => result.current.installPlaylistTimeline({
            getCurrentTime: () => 1,
            getDuration: () => 10,
            seekTo: vi.fn(),
        }));
        act(() => result.current.refresh());
        expect(result.current.duration).toBe(10);

        act(() => result.current.installPlaylistTimeline({
            getCurrentTime: () => 2,
            getDuration: () => 20,
            seekTo: vi.fn(),
        }));
        act(() => result.current.refresh());
        expect(result.current.duration).toBe(20);
    });

    it('seekTo delegates to the timeline when one is installed', () => {
        const audio = audioFixture({ currentTime: 5, duration: 30 });
        const audioRef = { current: audio };
        const seekTo = vi.fn((seconds) => seconds);
        const { result } = renderHook(() => useReaderTransport(audioRef));
        act(() => result.current.installPlaylistTimeline({
            getCurrentTime: () => 5,
            getDuration: () => 30,
            seekTo,
        }));
        act(() => result.current.seekTo(15));
        expect(seekTo).toHaveBeenCalledWith(15, audio);
    });
});
