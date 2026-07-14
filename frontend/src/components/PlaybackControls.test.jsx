import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PlaybackControls from './PlaybackControls';

function transport(overrides = {}) {
  return {
    currentTime: 1,
    duration: 10,
    isPlaying: false,
    mediaError: '',
    playbackRate: 1,
    cycleRate: vi.fn(),
    seekTo: vi.fn(),
    skipBy: vi.fn(),
    toggle: vi.fn(),
    ...overrides,
  };
}

describe('PlaybackControls', () => {
  it('keeps pause and stop available while later audio is generating', () => {
    const onToggle = vi.fn();
    const onStop = vi.fn();
    render(
      <PlaybackControls
        transport={transport({ isPlaying: true })}
        onToggle={onToggle}
        onStop={onStop}
        disabled
        generating
        hasMedia
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pause narration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop narration' }));
    expect(screen.getByText('Back 10')).toBeVisible();
    expect(screen.getByText('Forward 10')).toBeVisible();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
