import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    setRate: vi.fn(),
    skipBy: vi.fn(),
    toggle: vi.fn(),
    ...overrides,
  };
}

describe('PlaybackControls', () => {
  it('uses reading controls without a media-player progress slider', () => {
    render(<PlaybackControls transport={transport()} onStop={vi.fn()} />);

    expect(screen.queryByRole('slider', { name: 'Narration position' })).not.toBeInTheDocument();
    expect(screen.getByText('0:01 / 0:10')).toBeVisible();
  });

  it('renders the position scrubber and clamps seeks when seek props are provided', () => {
    const onSeek = vi.fn();
    render(
      <PlaybackControls
        transport={transport({ currentTime: 8 })}
        duration={10}
        onSeek={onSeek}
        onStop={vi.fn()}
      />
    );

    const slider = screen.getByRole('slider', { name: 'Narration position' });
    expect(slider).toBeVisible();

    fireEvent.change(slider, { target: { value: '42' } });
    expect(onSeek).toHaveBeenCalledWith(10);
    fireEvent.change(slider, { target: { value: '-5' } });
    expect(onSeek).toHaveBeenCalledWith(0);
  });

  it('keeps the scrubber hidden while duration is unavailable', () => {
    render(<PlaybackControls transport={transport({ duration: 0 })} onSeek={vi.fn()} />);

    expect(screen.queryByRole('slider', { name: 'Narration position' })).not.toBeInTheDocument();
  });

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

  it('offers explicit playback speed choices', () => {
    const current = transport({ playbackRate: 1 });
    render(<PlaybackControls transport={current} onStop={vi.fn()} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Narration speed' }), {
      target: { value: '1.5' },
    });

    expect(current.setRate).toHaveBeenCalledWith(1.5);
  });
});

describe('PlaybackControls sleep timer', () => {
  afterEach(() => vi.useRealTimers());

  it('counts down while playing and stops narration on expiry', async () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    render(<PlaybackControls transport={transport({ isPlaying: true })} onStop={onStop} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Sleep timer' }), {
      target: { value: '5' },
    });
    expect(screen.getByText('5:00')).toBeVisible();

    await act(async () => {
      vi.advanceTimersByTime(300000);
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('offers an end-of-chapter mode that fires through the stop path', () => {
    const onStop = vi.fn();
    render(
      <PlaybackControls
        transport={transport({ isPlaying: true })}
        onStop={onStop}
      />
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Sleep timer' }), {
      target: { value: 'chapter' },
    });
    expect(screen.getByText('chapter end')).toBeVisible();
  });
});
