import { describe, it, expect } from 'vitest';
import { shiftTimingsToOnset } from './audioOnset';

describe('shiftTimingsToOnset', () => {
  it('shifts all times so first word lands near onset', () => {
    const times = [0.1, 0.5, 1.0];
    const shifted = shiftTimingsToOnset(times, 0.05, 5);
    expect(shifted[0]).toBeCloseTo(0.05, 3);
    expect(shifted[1]).toBeCloseTo(0.45, 3);
    expect(shifted[2]).toBeCloseTo(0.95, 3);
  });

  it('is a no-op for tiny deltas', () => {
    const times = [0.1, 0.2];
    expect(shiftTimingsToOnset(times, 0.102)).toEqual(times);
  });
});
