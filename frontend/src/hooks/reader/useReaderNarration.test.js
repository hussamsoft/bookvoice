/**
 * Direct tests for useReaderNarration's naturalEndRef contract (B-20 /
 * audit finding L-4). The rest of the hook is covered through
 * Reader.test.jsx via the Reader composition; this file focuses on the
 * natural-end / user-stop distinction that the sleep timer relies on.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the API module before importing the hook.
vi.mock('../../utils/api', () => ({
    narrateTextStream: vi.fn(),
    cancelGeneration: vi.fn(),
    bumpGeneration: vi.fn(),
    pronounceText: vi.fn(),
}));

vi.mock('../../utils/playlistController', () => ({
    buildPlaylist: (chunks) => ({
        chunks,
        ranges: chunks.map((c) => ({ start_s: c.start_s, end_s: c.end_s })),
        totalDurationS: chunks.length ? chunks[chunks.length - 1].end_s : 0,
    }),
}));

import { useReaderNarration } from './useReaderNarration';

function makeAudioElement() {
    const listeners = new Map();
    const audio = {
        src: '',
        paused: true,
        currentTime: 0,
        duration: 0,
        volume: 1,
        playbackRate: 1,
        addEventListener(event, fn) {
            const set = listeners.get(event) ?? new Set();
            set.add(fn);
            listeners.set(event, set);
        },
        removeEventListener(event, fn) {
            const set = listeners.get(event);
            if (set) set.delete(fn);
        },
        dispatch(event) {
            const set = listeners.get(event);
            if (set) for (const fn of set) fn({});
        },
        play() { return Promise.resolve(); },
        pause() { this.paused = true; },
    };
    return audio;
}

function makeArgs(overrides = {}) {
    return {
        audioRef: { current: makeAudioElement() },
        transport: {
            currentTime: 0,
            duration: 0,
            installPlaylistTimeline: () => {},
            clearPlaylistTimeline: () => {},
            skipBy: () => {},
            seekTo: () => 0,
            pause: () => {},
        },
        sessionId: 'reader-1',
        voiceId: null,
        languageId: 'en',
        modelReady: true,
        getPage: vi.fn().mockResolvedValue('hello world'),
        onNarratePage: vi.fn(),
        toast: { error: vi.fn(), info: vi.fn() },
        ...overrides,
    };
}

describe('useReaderNarration naturalEndRef', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('exposes naturalEndRef in its return surface', () => {
        const { result } = renderHook(() => useReaderNarration(makeArgs()));
        expect(result.current).toHaveProperty('naturalEndRef');
        expect(result.current.naturalEndRef).toHaveProperty('current');
        // Default false.
        expect(result.current.naturalEndRef.current).toBe(false);
    });

    it('resets naturalEndRef.current on stopPlayback', () => {
        const { result } = renderHook(() => useReaderNarration(makeArgs()));
        // Force the natural-end ref to true to simulate a previous
        // natural-end event.
        result.current.naturalEndRef.current = true;
        expect(result.current.naturalEndRef.current).toBe(true);
        act(() => {
            result.current.stopPlayback();
        });
        expect(result.current.naturalEndRef.current).toBe(false);
    });
});
