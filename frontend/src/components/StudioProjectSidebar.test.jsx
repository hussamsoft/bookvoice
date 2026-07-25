import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StudioProjectSidebar from './StudioProjectSidebar';
import * as api from '../utils/api';
import { resetCapabilities } from '../utils/capabilities';

vi.mock('../utils/api', () => ({
    getAccess: vi.fn(),
    getUserConfig: vi.fn(),
}));

const projects = [
    { id: 'a'.repeat(32), name: 'Interview edit', diskBytes: 2_400_000 },
    { id: 'b'.repeat(32), name: 'Audiobook draft', diskBytes: 900_000 },
];

function renderSidebar(props = {}) {
    return render(
        <StudioProjectSidebar
            projects={projects}
            activeId={projects[0].id}
            onOpen={vi.fn()}
            onCreate={vi.fn()}
            onDuplicate={vi.fn()}
            onDelete={vi.fn()}
            onOpenFolder={vi.fn()}
            {...props}
        />,
    );
}

describe('StudioProjectSidebar', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetCapabilities();
        api.getUserConfig.mockResolvedValue({ capabilities: { localFileActions: true } });
    });

    it('summarises the active project so the list can collapse on a phone', async () => {
        renderSidebar();

        const toggle = await screen.findByRole('button', { expanded: false });
        expect(toggle).toHaveTextContent('Interview edit');
    });

    it('expands and collapses the project list', async () => {
        renderSidebar();
        const toggle = await screen.findByRole('button', { expanded: false });

        fireEvent.click(toggle);
        expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { expanded: true }));
        expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();
    });

    it('collapses after opening a project, so the work is on screen', async () => {
        const onOpen = vi.fn();
        renderSidebar({ onOpen });

        fireEvent.click(await screen.findByRole('button', { expanded: false }));
        fireEvent.click(screen.getByText('Audiobook draft'));

        expect(onOpen).toHaveBeenCalledWith(projects[1].id);
        expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();
    });

    it('falls back to a neutral label when nothing is open yet', async () => {
        renderSidebar({ activeId: null });

        expect(await screen.findByRole('button', { expanded: false })).toHaveTextContent('No project');
    });
});
