import { describe, it, expect } from 'vitest';
import { mapCoverCropToVideo } from './cameraCrop';

describe('mapCoverCropToVideo', () => {
  it('maps a centered portrait cutout into video pixels', () => {
    const video = { videoWidth: 1080, videoHeight: 1920 };
    const videoDisplay = { width: 360, height: 480, left: 0, top: 0 };
    // Centered page frame
    const crop = {
      left: 60,
      top: 40,
      width: 240,
      height: 340,
    };
    const mapped = mapCoverCropToVideo(video, videoDisplay, crop);
    expect(mapped).not.toBeNull();
    expect(mapped.sx).toBeGreaterThanOrEqual(0);
    expect(mapped.sy).toBeGreaterThanOrEqual(0);
    expect(mapped.sw).toBeGreaterThan(0);
    expect(mapped.sh).toBeGreaterThan(0);
    expect(mapped.sx + mapped.sw).toBeLessThanOrEqual(video.videoWidth + 0.01);
    expect(mapped.sy + mapped.sh).toBeLessThanOrEqual(video.videoHeight + 0.01);
  });
});
