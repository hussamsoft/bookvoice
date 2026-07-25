import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AccessGate from './AccessGate';
import * as api from '../utils/api';
import { resetCapabilities } from '../utils/capabilities';

vi.mock('../utils/api', () => ({
    getAccess: vi.fn(),
    getUserConfig: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
}));

function renderGate() {
    return render(<AccessGate><p>Protected content</p></AccessGate>);
}

describe('AccessGate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetCapabilities();
    });

    it('renders the app directly when the desktop reports no gate', async () => {
        api.getAccess.mockResolvedValue({ authRequired: false, authenticated: true });

        renderGate();

        expect(await screen.findByText('Protected content')).toBeInTheDocument();
        expect(screen.queryByLabelText('Access password')).not.toBeInTheDocument();
    });

    it('lets an already-signed-in session straight through', async () => {
        api.getAccess.mockResolvedValue({ authRequired: true, authenticated: true });

        renderGate();

        expect(await screen.findByText('Protected content')).toBeInTheDocument();
    });

    it('asks for the password and reveals the app once accepted', async () => {
        api.getAccess.mockResolvedValue({ authRequired: true, authenticated: false });
        api.signIn.mockResolvedValue({ authRequired: true, authenticated: true });

        renderGate();

        const field = await screen.findByLabelText('Access password');
        expect(screen.queryByText('Protected content')).not.toBeInTheDocument();

        fireEvent.change(field, { target: { value: 'a-long-enough-password' } });
        fireEvent.click(screen.getByRole('button', { name: /Sign in/i }));

        await waitFor(() => expect(api.signIn).toHaveBeenCalledWith('a-long-enough-password'));
        expect(await screen.findByText('Protected content')).toBeInTheDocument();
    });

    it('reports a rejected password without revealing the app', async () => {
        api.getAccess.mockResolvedValue({ authRequired: true, authenticated: false });
        api.signIn.mockRejectedValue(new Error('That password is not correct.'));

        renderGate();

        fireEvent.change(await screen.findByLabelText('Access password'), {
            target: { value: 'wrong' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Sign in/i }));

        expect(await screen.findByRole('alert')).toHaveTextContent('That password is not correct.');
        expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
    });

    it('treats an unreachable backend as no gate rather than locking the app out', async () => {
        api.getAccess.mockRejectedValue(new Error('offline'));

        renderGate();

        expect(await screen.findByText('Protected content')).toBeInTheDocument();
    });
});
