import { describe, it, expect } from 'vitest';
import { estimateWordTimings, wordIndexAtTime } from './timings';

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
    // Gap after "end." should be larger than gap after "a"
    const gapA = times[1] - times[0];
    const gapEnd = times[2] - times[1];
    expect(gapEnd).toBeGreaterThan(gapA);
  });
});

describe('wordIndexAtTime', () => {
  it('finds the correct index', () => {
    const times = [0, 1, 2, 3];
    expect(wordIndexAtTime(times, 0)).toBe(0);
    expect(wordIndexAtTime(times, 1.5)).toBe(1);
    expect(wordIndexAtTime(times, 3.2)).toBe(3);
    expect(wordIndexAtTime([], 1)).toBe(-1);
  });
});
