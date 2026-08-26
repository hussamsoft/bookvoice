import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StudioNarration from './StudioNarration';
import { createStudioRepair } from '../utils/api';

vi.mock('../utils/api', () => ({
    createStudioNarration: vi.fn(),
    createStudioRepair: vi.fn(),
}));

function makeTimings(count) {
    return Array.from({ length: count }, (_, index) => ({
        word: `w${index}`,
        startSec: index * 0.5,
        endSec: index * 0.5 + 0.4,
    }));
}

const project = {
    id: 'a'.repeat(32),
    name: 'Demo voice project',
    script: 'A script.',
    languageId: 'en',
    voiceId: null,
    generationSettings: {},
    sources: [],
    repairs: [],
    outputs: [{
        id: 'b'.repeat(32),
        kind: 'NARRATION',
        contentUrl: '/api/studio/audio',
        downloadUrl: '/api/studio/download',
        fileName: 'narration.wav',
        format: 'WAV',
        durationSec: 150,
        segments: [],
        wordTimings: makeTimings(300),
    }],
};

function renderNarration() {
    return render(
        <StudioNarration
            project={project}
            voices={[]}
            onPatch={vi.fn()}
            onRunJob={(label, submitter) => submitter()}
            disabled={false}
        />,
    );
}

function transcriptButtons(container) {
    const transcript = container.querySelector('.studio-transcript');
    return within(transcript);
}

describe('StudioNarration transcript windowing', () => {
    it('renders only a windowed slice of long transcripts behind ellipsis affordances', () => {
        const { container } = renderNarration();
        const buttons = transcriptButtons(container);
        const words = container.querySelectorAll('.studio-transcript button:not(.studio-transcript-more)');

        // ±25-word neighbourhoods keep the DOM bounded for 200k-character scripts.
        expect(words.length).toBe(50);
        expect(words[0].textContent).toBe('w0');
        expect(buttons.getByRole('button', { name: 'Show 250 more words' })).toBeInTheDocument();
        expect(buttons.queryByRole('button', { name: /earlier words/ })).not.toBeInTheDocument();
    });

    it('expands forward from the trailing ellipsis without rendering the whole performance', () => {
        const { container } = renderNarration();
        const buttons = transcriptButtons(container);

        fireEvent.click(buttons.getByRole('button', { name: 'Show 250 more words' }));

        const words = container.querySelectorAll('.studio-transcript button:not(.studio-transcript-more)');
        expect(words.length).toBe(300);
        expect(words[299].textContent).toBe('w299');
    });

    it('keeps click-to-repair working from a windowed word', async () => {
        createStudioRepair.mockResolvedValue({ id: 'c'.repeat(32), status: 'COMPLETED' });
        const { container } = renderNarration();
        const buttons = transcriptButtons(container);

        fireEvent.click(within(container.querySelector('.studio-transcript')).getByText('w12'));

        const editor = await screen.findByRole('textbox', { name: /Edit the sentence containing/i });
        fireEvent.change(editor, { target: { value: 'Rebuilt sentence.' } });
        fireEvent.click(screen.getByRole('button', { name: /Create corrected version/i }));

        await waitFor(() => expect(createStudioRepair).toHaveBeenCalledWith(project.id, expect.objectContaining({
            assetId: project.outputs[0].id,
            replacementText: 'Rebuilt sentence.',
            startSec: 6,
            endSec: 6.4,
        })));
        // The window did not need to move for an in-window click.
        expect(container.querySelectorAll('.studio-transcript button:not(.studio-transcript-more)').length).toBe(50);
        expect(buttons.getByRole('button', { name: 'Show 250 more words' })).toBeInTheDocument();
    });
});
