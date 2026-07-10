import { describe, it, expect } from 'vitest';
import {
  estimateWordTimings,
  estimateWordTimingsFromSegments,
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

describe('wordIndexAtTime', () => {
  it('finds the correct index', () => {
    const times = [0, 1, 2, 3];
    expect(wordIndexAtTime(times, 0, 0)).toBe(0);
    expect(wordIndexAtTime(times, 1.5, 0)).toBe(1);
    expect(wordIndexAtTime(times, 3.2, 0)).toBe(3);
    expect(wordIndexAtTime([], 1)).toBe(-1);
  });

  it('applies a small lead lag so highlight can lead the ear', () => {
    const times = [0, 1, 2];
    // At t=0.97 with 40ms lag → effectively 1.01 → word 1
    expect(wordIndexAtTime(times, 0.97, 40)).toBe(1);
  });
});
