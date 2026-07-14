import { describe, it, expect } from 'vitest';
import {
  estimateWordTimings,
  estimateWordTimingsFromSegments,
  stitchPartialTimings,
  highlightLagMs,
  timesFromWordTimings,
  wordIndexAtTime,
} from './timings';

describe('estimateWordTimings', () => {
  it('returns one start time per word and is monotonic', () => {
    const words = ['Hello', 'world.', 'This', 'is', 'a', 'test.'];
    const times = estimateWordTimings(words, 10, 'en');
    expect(times).toHaveLength(words.length);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
    expect(times[0]).toBeGreaterThanOrEqual(0);
    expect(times[times.length - 1]).toBeLessThan(10);
  });

  it('gives punctuation more pause weight than short words', () => {
    const words = ['a', 'end.', 'b'];
    const times = estimateWordTimings(words, 9, 'en');
    const gapA = times[1] - times[0];
    const gapEnd = times[2] - times[1];
    expect(gapEnd).toBeGreaterThan(gapA);
  });
});

describe('estimateWordTimingsFromSegments', () => {
  it('places later-segment words after earlier segment end', () => {
    const pageText = 'Hello world. Next sentence here.';
    const segments = [
      { text: 'Hello world.', start_s: 0, end_s: 2 },
      { text: 'Next sentence here.', start_s: 2, end_s: 5 },
    ];
    const { words, times } = estimateWordTimingsFromSegments(pageText, segments, 'en', 5);
    expect(words).toHaveLength(5);
    expect(times).toHaveLength(5);
    // First word of second segment should land at/after segment start.
    expect(times[2]).toBeGreaterThanOrEqual(1.9);
    expect(times[times.length - 1]).toBeLessThan(5);
  });

  it('falls back when segments are missing', () => {
    const pageText = 'One two three';
    const { words, times } = estimateWordTimingsFromSegments(pageText, [], 'en', 3);
    expect(words).toEqual(['One', 'two', 'three']);
    expect(times).toHaveLength(3);
  });
});

describe('stitchPartialTimings', () => {
  it('marks earlier words as sentinels and maps partial audio times', () => {
    const full = ['a', 'b', 'c', 'd'];
    const partial = [0, 0.3];
    const times = stitchPartialTimings(full, 2, partial);
    expect(times).toEqual([-1, -1, 0, 0.3]);
  });
});

describe('wordIndexAtTime', () => {
  it('finds the correct index', () => {
    const times = [0, 1, 2, 3];
    expect(wordIndexAtTime(times, 0, 0)).toBe(0);
    expect(wordIndexAtTime(times, 1.5, 0)).toBe(1);
    expect(wordIndexAtTime(times, 3.2, 0)).toBe(3);
    expect(wordIndexAtTime([], 1)).toBe(-1);
  });

  it('delays the highlight slightly to account for speaker output latency', () => {
    const times = [0, 1, 2];
    expect(highlightLagMs('en')).toBeLessThan(0);
    expect(wordIndexAtTime(times, 1.02, highlightLagMs('en'))).toBe(0);
  });

  it('does not highlight before the first measured word begins', () => {
    const times = [0.3, 0.8, 1.2];
    expect(wordIndexAtTime(times, 0.1, 0)).toBe(-1);
    expect(wordIndexAtTime(times, 0.3, 0)).toBe(0);
  });

  it('clears the highlight during a measured pause between words', () => {
    const times = [0.1, 1.0];
    const ends = [0.45, 1.3];
    expect(wordIndexAtTime(times, 0.3, 0, ends)).toBe(0);
    expect(wordIndexAtTime(times, 0.7, 0, ends)).toBe(-1);
    expect(wordIndexAtTime(times, 1.1, 0, ends)).toBe(1);
  });

  it('skips sentinel -1 slots used by partial voice-switch clips', () => {
    const times = [-1, -1, 0, 0.4, 0.9];
    expect(wordIndexAtTime(times, 0, 0)).toBe(2);
    expect(wordIndexAtTime(times, 0.5, 0)).toBe(3);
  });
});

describe('timesFromWordTimings', () => {
  it('interpolates unmatched words between forced-alignment anchors', () => {
    const aligned = [
      { word: 'One', start_s: 0, end_s: 0.3 },
      { word: 'brown', start_s: 1, end_s: 1.3 },
      { word: 'fox', start_s: 1.5, end_s: 1.8 },
    ];

    const { words, times, ends } = timesFromWordTimings(aligned, 'One quick brown fox');

    expect(words).toEqual(['One', 'quick', 'brown', 'fox']);
    expect(times).toEqual([0, 0.5, 1, 1.5]);
    // Measured ends for anchored words; inferred 'quick' uses next onset.
    expect(ends[0]).toBe(0.3);
    expect(ends[1]).toBe(1);
    expect(ends[2]).toBe(1.3);
    expect(ends[3]).toBe(1.8);
  });

  it('rejects low-coverage alignments instead of returning zero-filled timings', () => {
    const aligned = [{ word: 'three', start_s: 1, end_s: 1.2 }];
    const { times, ends } = timesFromWordTimings(aligned, 'one two three four');
    expect(times).toEqual([]);
    expect(ends).toEqual([]);
  });
});
