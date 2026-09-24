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
import { narrateTextStream } from '../../utils/api';

function makeAudioElement() {
    const listeners = new Map();
    const audio = {
        src: '',
        paused: true,
        readyState: 1,
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
        vi.clearAllMocks();
        narrateTextStream.mockReturnValue(new Promise(() => {}));
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

    it('sends the active prepared-book id when generating narration', () => {
        const { result } = renderHook(() => useReaderNarration(makeArgs({ bookId: 'book-7' })));

        act(() => {
            void result.current.startForLoadedPage(3, 'Page text', null, { autoplay: true });
        });

        expect(narrateTextStream).toHaveBeenCalledWith(
            'Page text',
            'reader-1',
            3,
            null,
            'en',
            expect.objectContaining({ bookId: 'book-7' }),
            expect.any(AbortSignal),
        );
    });

    it('exposes a word only for a complete monotonic backend timing map', async () => {
        narrateTextStream.mockImplementation(async (_text, _session, _page, _voice, _language, options) => {
            await options.onChunk({
                type: 'done',
                audio_url: '/sessions/reader/full.wav',
                segments: [],
                duration_s: 1,
                word_timings: [
                    { word: 'Hello', start_s: 0, end_s: 0.4 },
                    { word: 'world', start_s: 0.5, end_s: 0.9 },
                ],
            });
            return { type: 'done' };
        });
        const args = makeArgs({ bookId: 'book-7' });
        const { result } = renderHook(() => useReaderNarration(args));
        await act(async () => {
            await result.current.startForLoadedPage(1, 'Hello world', null, { autoplay: true });
        });

        const audio = args.audioRef.current;
        act(() => {
            audio.currentTime = 0.6;
            audio.dispatch('timeupdate');
        });
        expect(result.current.currentWord).toBe(1);
    });
});
