/**
 * Pure-logic gapless playlist controller for progressive chunk playback.
 *
 * Maps a list of audio chunks (each with an absolute start_s offset from the
 * streaming response) into per-chunk source state and global highlight timing.
 * No DOM access — fully unit-testable; the playback component drives an <audio>
 * element from the values this returns.
 */

/**
 * Build a playlist from streamed chunks.
 * Each chunk: { url, text, start_s, end_s, index, total }
 * Returns { chunks, totalDurationS, ranges } where ranges[i] = {start_s, end_s}.
 */
export function buildPlaylist(streamedChunks) {
    const chunks = [...streamedChunks].sort((a, b) => a.index - b.index);
    const ranges = chunks.map((c) => ({ start_s: c.start_s, end_s: c.end_s }));
    const totalDurationS = chunks.length ? ranges[ranges.length - 1].end_s : 0;
    return { chunks, totalDurationS, ranges };
}

/**
 * Given the current chunk index and the time within that chunk's audio element,
 * return the absolute (global) playback time for highlight lookup.
 */
export function globalTimeForChunk(playlist, chunkIndex, localTimeS) {
    if (!playlist.ranges.length) return 0;
    const idx = Math.max(0, Math.min(chunkIndex, playlist.ranges.length - 1));
    const base = playlist.ranges[idx].start_s;
    const end = playlist.ranges[idx].end_s;
    // Clamp local time into this chunk's span so highlight doesn't overshoot.
    const span = Math.max(0, end - base);
    const clamped = Math.max(0, Math.min(localTimeS, span));
    return base + clamped;
}

/**
 * Decide the next chunk index after `current` finishes, or null at the end.
 */
export function nextChunkIndex(playlist, current) {
    const next = current + 1;
    return next < playlist.chunks.length ? next : null;
}

/**
 * Index of the chunk whose [start_s, end_s) span contains a global time, or the
 * last chunk if time exceeds total duration (end-of-playback).
 */
export function chunkIndexAtGlobalTime(playlist, globalTimeS) {
    const { ranges } = playlist;
    if (!ranges.length) return 0;
    for (let i = 0; i < ranges.length; i++) {
        if (globalTimeS < ranges[i].end_s) return i;
    }
    return ranges.length - 1;
}

/**
 * Local time (within the chunk's own audio element) for a global time.
 */
export function localTimeForChunk(playlist, chunkIndex, globalTimeS) {
    if (!playlist.ranges.length) return 0;
    const idx = Math.max(0, Math.min(chunkIndex, playlist.ranges.length - 1));
    return Math.max(0, globalTimeS - playlist.ranges[idx].start_s);
}

/**
 * Whether all chunks have arrived (playlist complete) for a given expected total.
 */
export function isComplete(playlist, expectedTotal) {
    return (
        playlist.chunks.length > 0 &&
        (expectedTotal == null || playlist.chunks.length >= expectedTotal)
    );
}
