import { describe, expect, it } from 'vitest';
import { waitForAudioMetadata } from './media';

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
