import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UpdateBanner from './UpdateBanner';
import { downloadUpdate, getUpdateStatus, installUpdate } from '../utils/api';

vi.mock('../utils/api', () => ({
    getUpdateStatus: vi.fn(),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(),
}));

const base = {
    current: '2.6.3',
    latest: '2.7.0',
    updateAvailable: true,
    supported: true,
    enabled: true,
    releaseUrl: 'https://github.com/hussamsoft/bookvoice/releases/tag/v2.7.0',
    error: null,
    download: { state: 'idle' },
};

describe('UpdateBanner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('stays out of the way when the app is current', async () => {
        getUpdateStatus.mockResolvedValue({ ...base, updateAvailable: false });
        const { container } = render(<UpdateBanner />);
        await waitFor(() => expect(getUpdateStatus).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it('says nothing when the backend cannot be reached', async () => {
        // An older backend has no /api/updates at all. Surfacing that as an
        // error banner would be worse than surfacing nothing.
        getUpdateStatus.mockRejectedValue(new Error('404'));
        const { container } = render(<UpdateBanner />);
        await waitFor(() => expect(getUpdateStatus).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it('names both versions so the user knows what changes', async () => {
        getUpdateStatus.mockResolvedValue(base);
        render(<UpdateBanner />);
        expect(await screen.findByRole('status')).toHaveTextContent(
            'BookVoice 2.7.0 is available (you have 2.6.3).'
        );
    });

    it('downloads before it offers to install', async () => {
        getUpdateStatus.mockResolvedValue(base);
        downloadUpdate.mockResolvedValue({ state: 'downloading' });
        render(<UpdateBanner />);

        fireEvent.click(await screen.findByRole('button', { name: /download/i }));
        expect(downloadUpdate).toHaveBeenCalledWith('2.7.0');
        expect(installUpdate).not.toHaveBeenCalled();
    });

    it('offers the restart only once the installer is staged', async () => {
        getUpdateStatus.mockResolvedValue({ ...base, download: { state: 'ready' } });
        render(<UpdateBanner />);
        expect(
            await screen.findByRole('button', { name: /restart and install/i })
        ).toBeInTheDocument();
    });

    it('confirms before closing the app, and does not install if declined', async () => {
        getUpdateStatus.mockResolvedValue({ ...base, download: { state: 'ready' } });
        render(<UpdateBanner />);

        fireEvent.click(await screen.findByRole('button', { name: /restart and install/i }));
        expect(await screen.findByText(/BookVoice will close/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /not now/i }));
        expect(installUpdate).not.toHaveBeenCalled();
    });

    it('installs once the user confirms', async () => {
        getUpdateStatus.mockResolvedValue({ ...base, download: { state: 'ready' } });
        installUpdate.mockResolvedValue({ version: '2.7.0' });
        render(<UpdateBanner />);

        fireEvent.click(await screen.findByRole('button', { name: /restart and install/i }));
        fireEvent.click(await screen.findByRole('button', { name: /close and install/i }));

        await waitFor(() => expect(installUpdate).toHaveBeenCalledWith('2.7.0'));
    });

    it('can be dismissed', async () => {
        getUpdateStatus.mockResolvedValue(base);
        render(<UpdateBanner />);

        fireEvent.click(await screen.findByRole('button', { name: /dismiss update notice/i }));
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    });

    it('reports a failed download instead of pretending it is ready', async () => {
        getUpdateStatus.mockResolvedValue({
            ...base,
            download: { state: 'failed', error: 'Checksum verification failed.' },
        });
        render(<UpdateBanner />);
        expect(await screen.findByRole('status')).toHaveTextContent(
            'Checksum verification failed.'
        );
    });
});
