import { describe, expect, it } from 'vitest';
import {
    buildPlaylist,
    chunkIndexAtGlobalTime,
    globalTimeForChunk,
    isComplete,
    localTimeForChunk,
    nextChunkIndex,
} from './playlistController';

const CHUNKS = [
    { url: '/a.wav', text: 'one', start_s: 0, end_s: 2, index: 0, total: 3 },
    { url: '/b.wav', text: 'two', start_s: 2, end_s: 5, index: 1, total: 3 },
    { url: '/c.wav', text: 'three', start_s: 5, end_s: 7, index: 2, total: 3 },
];

describe('playlistController', () => {
    it('sorts chunks by index and computes total duration', () => {
        const pl = buildPlaylist([CHUNKS[2], CHUNKS[0], CHUNKS[1]]);
        expect(pl.chunks.map((c) => c.index)).toEqual([0, 1, 2]);
        expect(pl.totalDurationS).toBe(7);
        expect(pl.ranges).toEqual([
            { start_s: 0, end_s: 2 },
            { start_s: 2, end_s: 5 },
            { start_s: 5, end_s: 7 },
        ]);
    });

    it('maps local chunk time to global highlight time', () => {
        const pl = buildPlaylist(CHUNKS);
        expect(globalTimeForChunk(pl, 0, 0)).toBe(0);
        expect(globalTimeForChunk(pl, 0, 1.5)).toBe(1.5);
        // chunk 1 (offset 2s), 1s into it -> 3s global
        expect(globalTimeForChunk(pl, 1, 1)).toBe(3);
        // clamps local time to the chunk's span
        expect(globalTimeForChunk(pl, 0, 99)).toBe(2);
    });

    it('advances to the next chunk or null at the end', () => {
        const pl = buildPlaylist(CHUNKS);
        expect(nextChunkIndex(pl, 0)).toBe(1);
        expect(nextChunkIndex(pl, 1)).toBe(2);
        expect(nextChunkIndex(pl, 2)).toBeNull();
    });

    it('finds the chunk containing a global time', () => {
        const pl = buildPlaylist(CHUNKS);
        expect(chunkIndexAtGlobalTime(pl, 0)).toBe(0);
        expect(chunkIndexAtGlobalTime(pl, 1.9)).toBe(0);
        expect(chunkIndexAtGlobalTime(pl, 2)).toBe(1);
        expect(chunkIndexAtGlobalTime(pl, 4.9)).toBe(1);
        expect(chunkIndexAtGlobalTime(pl, 5)).toBe(2);
        // beyond the end -> last chunk (end-of-playback sentinel)
        expect(chunkIndexAtGlobalTime(pl, 99)).toBe(2);
    });

    it('maps global time back to local chunk time', () => {
        const pl = buildPlaylist(CHUNKS);
        expect(localTimeForChunk(pl, 0, 1)).toBe(1);
        expect(localTimeForChunk(pl, 1, 3)).toBe(1);
        expect(localTimeForChunk(pl, 2, 6)).toBe(1);
    });

    it('reports completeness against an expected total', () => {
        const full = buildPlaylist(CHUNKS);
        expect(isComplete(full, 3)).toBe(true);
        expect(isComplete(full, 4)).toBe(false);
        const partial = buildPlaylist(CHUNKS.slice(0, 2));
        expect(isComplete(partial, 3)).toBe(false);
    });

    it('handles an empty playlist gracefully', () => {
        const pl = buildPlaylist([]);
        expect(pl.totalDurationS).toBe(0);
        expect(globalTimeForChunk(pl, 0, 5)).toBe(0);
        expect(nextChunkIndex(pl, 0)).toBeNull();
        expect(isComplete(pl, 1)).toBe(false);
    });
});
