import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StudioRecorder from './StudioRecorder';
import { canRecord } from '../utils/media';

vi.mock('../utils/wav', () => ({
    recordStreamToWav: vi.fn(),
}));

import { recordStreamToWav } from '../utils/wav';

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

function setMediaDevices(value) {
    Object.defineProperty(navigator, 'mediaDevices', {
        value,
        configurable: true,
        writable: true,
    });
}

describe('StudioRecorder', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        if (originalMediaDevices) {
            Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
        } else {
            delete navigator.mediaDevices;
        }
    });

    it('explains itself instead of offering a dead button without a secure context', () => {
        // Over plain HTTP on a LAN the browser does not expose mediaDevices at all.
        setMediaDevices(undefined);
        expect(canRecord()).toBe(false);

        render(<StudioRecorder onRecorded={vi.fn()} />);

        expect(screen.getByText(/needs a secure connection/i)).toBeInTheDocument();
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('records and hands the finished clip to its caller', async () => {
        const track = { stop: vi.fn() };
        const stream = { getTracks: () => [track] };
        const blob = new Blob([new Uint8Array(4096)], { type: 'audio/wav' });
        setMediaDevices({ getUserMedia: vi.fn().mockResolvedValue(stream) });
        recordStreamToWav.mockResolvedValue({ stop: vi.fn().mockResolvedValue(blob) });
        const onRecorded = vi.fn().mockResolvedValue(undefined);

        render(<StudioRecorder onRecorded={onRecorded} label="Record this voice" />);
        fireEvent.click(screen.getByRole('button', { name: 'Record this voice' }));

        const stopButton = await screen.findByRole('button', { name: 'Stop recording' });
        fireEvent.click(stopButton);

        await waitFor(() => expect(onRecorded).toHaveBeenCalled());
        const [received, name] = onRecorded.mock.calls[0];
        expect(received).toBe(blob);
        expect(name).toMatch(/^recording-.*\.wav$/);
        // The microphone must be released, or the browser keeps showing it as live.
        expect(track.stop).toHaveBeenCalled();
    });

    it('reports a refused microphone rather than appearing to record', async () => {
        setMediaDevices({ getUserMedia: vi.fn().mockRejectedValue(new Error('denied')) });

        render(<StudioRecorder onRecorded={vi.fn()} />);
        fireEvent.click(screen.getByRole('button'));

        expect(await screen.findByRole('alert')).toHaveTextContent(/microphone/i);
    });

    it('rejects a clip too short to be useful', async () => {
        const stream = { getTracks: () => [{ stop: vi.fn() }] };
        setMediaDevices({ getUserMedia: vi.fn().mockResolvedValue(stream) });
        recordStreamToWav.mockResolvedValue({
            stop: vi.fn().mockResolvedValue(new Blob([new Uint8Array(10)])),
        });
        const onRecorded = vi.fn();

        render(<StudioRecorder onRecorded={onRecorded} />);
        fireEvent.click(screen.getByRole('button'));
        fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/too short/i);
        expect(onRecorded).not.toHaveBeenCalled();
    });
});
