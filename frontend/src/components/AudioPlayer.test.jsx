import React, { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AudioPlayer from './AudioPlayer';

describe('AudioPlayer', () => {
    it('draws its own transport instead of the browser default', () => {
        // Native controls are an opaque dark slab in Safari that ignores the theme.
        const { container } = render(<AudioPlayer src="/audio.wav" label="the narration" />);

        const audio = container.querySelector('audio');
        expect(audio).toBeInTheDocument();
        expect(audio).not.toHaveAttribute('controls');
        expect(screen.getByRole('button', { name: 'Play the narration' })).toBeInTheDocument();
        expect(screen.getByRole('slider', { name: 'Seek the narration' })).toBeInTheDocument();
    });

    it('follows the element rather than assuming its own state', () => {
        const { container } = render(<AudioPlayer src="/audio.wav" label="clip" />);
        const audio = container.querySelector('audio');

        fireEvent.play(audio);
        expect(screen.getByRole('button', { name: 'Pause clip' })).toBeInTheDocument();

        fireEvent.pause(audio);
        expect(screen.getByRole('button', { name: 'Play clip' })).toBeInTheDocument();

        fireEvent.play(audio);
        fireEvent.ended(audio);
        expect(screen.getByRole('button', { name: 'Play clip' })).toBeInTheDocument();
    });

    it('exposes the audio element so callers can drive region playback', () => {
        // StudioConversion and the voice cloner seek to a selected range.
        const ref = createRef();
        const { container } = render(<AudioPlayer ref={ref} src="/audio.wav" />);

        expect(ref.current).toBe(container.querySelector('audio'));
    });

    it('passes time updates through to the caller', () => {
        const onTimeUpdate = vi.fn();
        const { container } = render(<AudioPlayer src="/audio.wav" onTimeUpdate={onTimeUpdate} />);

        fireEvent.timeUpdate(container.querySelector('audio'));

        expect(onTimeUpdate).toHaveBeenCalled();
    });

    it('shows a placeholder duration until metadata arrives', () => {
        render(<AudioPlayer src="/audio.wav" />);

        expect(screen.getByText(/0:00/)).toBeInTheDocument();
        // A stream with no known duration must not render NaN.
        expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    });
});
