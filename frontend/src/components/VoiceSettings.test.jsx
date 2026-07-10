import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import VoiceSettings from './VoiceSettings';

vi.mock('../utils/api', () => ({
  getVoices: vi.fn(),
  uploadVoice: vi.fn(),
}));

vi.mock('./Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

import { getVoices } from '../utils/api';

const VOICES = [
  { id: 'Ryan', name: 'Ryan' },
  { id: 'Aria', name: 'Aria' },
];

describe('VoiceSettings saved-voice revalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVoices.mockResolvedValue(VOICES);
  });

  it('keeps a valid saved voice after voices load', async () => {
    const onVoiceChange = vi.fn();
    render(<VoiceSettings activeVoiceId="Ryan" onVoiceChange={onVoiceChange} />);

    await waitFor(() => {
      expect(getVoices).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('Ryan');
    });
    expect(onVoiceChange).not.toHaveBeenCalled();
  });

  it('clears a deleted saved voice once voices are known', async () => {
    const onVoiceChange = vi.fn();
    render(<VoiceSettings activeVoiceId="DeletedVoice" onVoiceChange={onVoiceChange} />);

    await waitFor(() => {
      expect(onVoiceChange).toHaveBeenCalledWith(null);
    });
    // Must not loop: only one clear for the same missing id.
    expect(onVoiceChange).toHaveBeenCalledTimes(1);
  });

  it('revalidates when activeVoiceId arrives later (async config restore)', async () => {
    const onVoiceChange = vi.fn();
    const { rerender } = render(
      <VoiceSettings activeVoiceId={null} onVoiceChange={onVoiceChange} />
    );

    await waitFor(() => expect(getVoices).toHaveBeenCalled());

    // Config loads after mount with a voice that no longer exists.
    await act(async () => {
      rerender(
        <VoiceSettings activeVoiceId="GoneVoice" onVoiceChange={onVoiceChange} />
      );
    });

    await waitFor(() => {
      expect(onVoiceChange).toHaveBeenCalledWith(null);
    });
  });

  it('restores a valid late-arriving saved voice without clearing it', async () => {
    const onVoiceChange = vi.fn();
    const { rerender } = render(
      <VoiceSettings activeVoiceId={null} onVoiceChange={onVoiceChange} />
    );

    await waitFor(() => expect(getVoices).toHaveBeenCalled());

    await act(async () => {
      rerender(
        <VoiceSettings activeVoiceId="Aria" onVoiceChange={onVoiceChange} />
      );
    });

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('Aria');
    });
    expect(onVoiceChange).not.toHaveBeenCalled();
  });
});
