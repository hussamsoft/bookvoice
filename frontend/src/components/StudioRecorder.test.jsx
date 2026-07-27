import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        globalThis.URL.createObjectURL = vi.fn(() => 'blob:take');
        globalThis.URL.revokeObjectURL = vi.fn();
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

    async function recordATake(onRecorded, blob) {
        const track = { stop: vi.fn() };
        setMediaDevices({ getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) });
        recordStreamToWav.mockResolvedValue({ stop: vi.fn().mockResolvedValue(blob) });

        render(<StudioRecorder onRecorded={onRecorded} label="Record this voice" />);
        fireEvent.click(screen.getByRole('button', { name: 'Record this voice' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));
        await screen.findByText(/Review your recording/i);
        return track;
    }

    it('offers the take for review instead of committing it immediately', async () => {
        const blob = new Blob([new Uint8Array(4096)], { type: 'audio/wav' });
        const onRecorded = vi.fn().mockResolvedValue(undefined);

        const track = await recordATake(onRecorded, blob);

        // Nothing is saved until it has been listened to and accepted.
        expect(onRecorded).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: /Play your recording/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument();
        // The microphone must be released, or the browser keeps showing it as live.
        expect(track.stop).toHaveBeenCalled();
    });

    it('hands the take over once accepted', async () => {
        const blob = new Blob([new Uint8Array(4096)], { type: 'audio/wav' });
        const onRecorded = vi.fn().mockResolvedValue(undefined);

        await recordATake(onRecorded, blob);
        fireEvent.click(screen.getByRole('button', { name: /Use this recording/i }));

        await waitFor(() => expect(onRecorded).toHaveBeenCalled());
        const [received, name] = onRecorded.mock.calls[0];
        expect(received).toBe(blob);
        expect(name).toMatch(/^recording-.*\.wav$/);
    });

    it('discards the take on delete and returns to the record button', async () => {
        const blob = new Blob([new Uint8Array(4096)], { type: 'audio/wav' });
        const onRecorded = vi.fn();

        await recordATake(onRecorded, blob);
        fireEvent.click(screen.getByRole('button', { name: /Delete/i }));

        expect(onRecorded).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Record this voice' })).toBeInTheDocument();
        expect(screen.queryByText(/Review your recording/i)).not.toBeInTheDocument();
    });

    it('shows a live meter while recording', async () => {
        setMediaDevices({ getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) });
        let emit;
        recordStreamToWav.mockImplementation(async (_stream, { onLevel }) => {
            emit = onLevel;
            return { stop: vi.fn().mockResolvedValue(new Blob([new Uint8Array(4096)])) };
        });

        const { container } = render(<StudioRecorder onRecorded={vi.fn()} />);
        fireEvent.click(screen.getByRole('button'));
        await screen.findByRole('button', { name: 'Stop recording' });

        const bars = container.querySelectorAll('.studio-record-bar');
        expect(bars.length).toBeGreaterThan(1);
        const before = bars[bars.length - 1].getAttribute('style');
        act(() => emit(0.5));
        expect(bars[bars.length - 1].getAttribute('style')).not.toBe(before);
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
        expect(screen.queryByText(/Review your recording/i)).not.toBeInTheDocument();
    });
});
