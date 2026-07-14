import { describe, expect, it } from 'vitest';
import { audioRangeForWord, waitForAudioMetadata } from './media';

describe('waitForAudioMetadata', () => {
  it('rejects when the media element reports an error', async () => {
    const audio = document.createElement('audio');
    const pending = waitForAudioMetadata(audio, 1000);
    audio.dispatchEvent(new Event('error'));
    await expect(pending).rejects.toThrow('Audio could not be loaded');
  });

  it('rejects instead of waiting forever', async () => {
    const audio = document.createElement('audio');
    await expect(waitForAudioMetadata(audio, 5)).rejects.toThrow('timed out');
  });
});

describe('audioRangeForWord', () => {
  it('uses the next word boundary and clamps the final word to duration', () => {
    expect(audioRangeForWord([0, 0.8, 1.7], 1, 2.4)).toEqual({ start: 0.8, end: 1.7 });
    expect(audioRangeForWord([0, 0.8, 1.7], 2, 2.4)).toEqual({ start: 1.7, end: 2.4 });
  });

  it('prefers measured word ends plus pad without overlapping the next word', () => {
    // Measured end 1.0 + 0.08 pad = 1.08, still before next onset 1.2.
    expect(audioRangeForWord([0, 0.5, 1.2], 1, 2.0, [0.4, 1.0, 1.5])).toEqual({
      start: 0.5,
      end: 1.08,
    });
  });
});
