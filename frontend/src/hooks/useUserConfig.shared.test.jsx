// F-33 — one config copy app-wide. Before the fix every useUserConfig()
// call owned its own state, so a save in one mounted consumer left the
// others serving stale values forever (latent until two consumers mount
// together). The provider gives a single owner with one invalidation path;
// the fallback instance keeps standalone hook users working.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserConfigProvider, useUserConfig } from './useUserConfig';

vi.mock('../utils/api', () => ({
    getUserConfig: vi.fn(),
    saveUserConfig: vi.fn(),
}));

import { getUserConfig, saveUserConfig } from '../utils/api';

function VoiceLabel({ label }) {
    const { config, loadError } = useUserConfig();
    return (
        <span data-testid={label}>
            {config?.voice_id ?? 'none'}{loadError ? '!' : ''}
        </span>
    );
}

function SaveButton() {
    const { updateConfig } = useUserConfig();
    return (
        <button type="button" onClick={() => updateConfig({ voice_id: 'Bella' })}>
            save Bella
        </button>
    );
}

describe('shared config via provider (F-33)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getUserConfig.mockResolvedValue({
            version: '1.0.0',
            config: { voice_id: 'Ryan', language_id: 'en' },
        });
        saveUserConfig.mockImplementation((partial) => Promise.resolve({
            version: '1.0.0',
            config: { voice_id: 'Ryan', language_id: 'en', ...partial },
        }));
    });

    it('all mounted consumers see one copy, and a save invalidates everywhere', async () => {
        render(
            <UserConfigProvider>
                <VoiceLabel label="a" />
                <SaveButton />
                <VoiceLabel label="b" />
            </UserConfigProvider>,
        );
        await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('Ryan'));
        expect(screen.getByTestId('b')).toHaveTextContent('Ryan');

        fireEvent.click(screen.getByRole('button', { name: 'save Bella' }));
        await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('Bella'));
        // The point of F-33: the other consumer updates too, immediately.
        expect(screen.getByTestId('b')).toHaveTextContent('Bella');
    });

    it('the provider fetches exactly once no matter how many consumers mount', async () => {
        render(
            <UserConfigProvider>
                <VoiceLabel label="a" />
                <VoiceLabel label="b" />
                <VoiceLabel label="c" />
            </UserConfigProvider>,
        );
        await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('Ryan'));
        expect(getUserConfig).toHaveBeenCalledTimes(1);
    });

    it('exposes loadError when the GET fails', async () => {
        getUserConfig.mockRejectedValueOnce(new Error('offline'));
        render(
            <UserConfigProvider>
                <VoiceLabel label="a" />
            </UserConfigProvider>,
        );
        await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('!'));
    });
});
