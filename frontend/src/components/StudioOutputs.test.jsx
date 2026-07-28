import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StudioOutputs from './StudioOutputs';

const output = {
    id: 'a'.repeat(32),
    kind: 'CONVERSION',
    fileName: 'interview-converted.wav',
    format: 'WAV',
    durationSec: 12.4,
    contentUrl: '/api/studio/projects/p/assets/a/content',
    downloadUrl: '/api/studio/projects/p/outputs/a/download',
};

function renderOutputs() {
    return render(<StudioOutputs outputs={[output]} />);
}

describe('StudioOutputs', () => {
    it('always downloads through the current browser instead of the host computer', async () => {
        renderOutputs();

        const link = await screen.findByRole('link', {
            name: /Download converted voice to this device/i,
        });
        expect(link).toHaveAttribute('href', output.downloadUrl);
        expect(link).toHaveAttribute('download', output.fileName);
        expect(screen.queryByRole('button', { name: /Save.*Downloads/i })).not.toBeInTheDocument();
    });
});
