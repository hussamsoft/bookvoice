import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StudioOutputs from './StudioOutputs';
import * as api from '../utils/api';
import { resetCapabilities } from '../utils/capabilities';

vi.mock('../utils/api', () => ({
    getAccess: vi.fn(),
    getUserConfig: vi.fn(),
    saveStudioOutput: vi.fn(),
}));

const output = {
    id: 'a'.repeat(32),
    kind: 'CONVERSION',
    fileName: 'interview-converted.wav',
    format: 'WAV',
    durationSec: 12.4,
    contentUrl: '/api/studio/projects/p/assets/a/content',
};

function renderOutputs() {
    return render(
        <StudioOutputs projectId={'p'.repeat(32)} outputs={[output]} onRunJob={vi.fn()} />,
    );
}

describe('StudioOutputs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetCapabilities();
    });

    it('offers Save to Downloads on the desktop', async () => {
        api.getUserConfig.mockResolvedValue({
            capabilities: { serverMode: false, localFileActions: true, authRequired: false },
        });

        renderOutputs();

        expect(await screen.findByRole('button', { name: /Save converted voice to Downloads/i }))
            .toBeInTheDocument();
    });

    it('offers a browser download when hosted, since the server has no Downloads folder', async () => {
        api.getUserConfig.mockResolvedValue({
            capabilities: { serverMode: true, localFileActions: false, authRequired: true },
        });

        renderOutputs();

        const link = await screen.findByRole('link', { name: /Download converted voice/i });
        expect(link).toHaveAttribute('href', output.contentUrl);
        expect(link).toHaveAttribute('download', output.fileName);
        expect(screen.queryByRole('button', { name: /Save.*Downloads/i })).not.toBeInTheDocument();
    });
});
