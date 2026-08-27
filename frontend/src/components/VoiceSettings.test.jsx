import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import VoiceSettings from './VoiceSettings';
import { getVoices } from '../utils/api';

vi.mock('../utils/api', () => ({
  getVoices: vi.fn(),
  uploadVoice: vi.fn(),
  deleteVoice: vi.fn(),
}));

vi.mock('./Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

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

  it('retries voice loading after the backend becomes ready', async () => {
    getVoices
      .mockRejectedValueOnce(new Error('starting'))
      .mockResolvedValue(VOICES);

    const { rerender } = render(
      <VoiceSettings backendReady={false} activeVoiceId={null} onVoiceChange={vi.fn()} />
    );

    await waitFor(() => expect(getVoices).toHaveBeenCalledTimes(1));

    await act(async () => {
      rerender(
        <VoiceSettings backendReady={true} activeVoiceId={null} onVoiceChange={vi.fn()} />
      );
    });

    await waitFor(() => expect(getVoices.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe('VoiceSettings compact dropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVoices.mockResolvedValue(VOICES);
  });

  it('renders a pill button in compact mode', async () => {
    render(<VoiceSettings compact activeVoiceId="Ryan" onVoiceChange={vi.fn()} />);
    expect(await screen.findByText('Ryan')).toBeInTheDocument();
    expect(screen.getByText('Voice:')).toBeInTheDocument();
  });

  it('expands dropdown on pill click', async () => {
    render(<VoiceSettings compact activeVoiceId="Ryan" onVoiceChange={vi.fn()} />);
    const pill = await screen.findByText('Ryan');
    fireEvent.click(pill);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('closes dropdown on Escape and returns focus to pill', async () => {
    render(<VoiceSettings compact activeVoiceId="Ryan" onVoiceChange={vi.fn()} />);
    const pill = await screen.findByText('Ryan');
    fireEvent.click(pill);
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('combobox')).toBeNull();
    });
    expect(document.activeElement).toBe(pill.closest('button'));
  });

  it('closes dropdown on outside click', async () => {
    render(<VoiceSettings compact activeVoiceId="Ryan" onVoiceChange={vi.fn()} />);
    const pill = await screen.findByText('Ryan');
    fireEvent.click(pill);
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    await waitFor(() => {
      expect(screen.queryByRole('combobox')).toBeNull();
    });
  });

  it('shows delete button when voice is selected', async () => {
    render(<VoiceSettings compact activeVoiceId="Ryan" onVoiceChange={vi.fn()} />);
    const pill = await screen.findByText('Ryan');
    fireEvent.click(pill);
    expect(await screen.findByLabelText('Delete selected voice')).toBeInTheDocument();
  });

  it('hides delete button when no voice is selected', async () => {
    render(<VoiceSettings compact activeVoiceId={null} onVoiceChange={vi.fn()} />);
    const pill = await screen.findByText('BookVoice Natural');
    fireEvent.click(pill);
    expect(screen.queryByLabelText('Delete selected voice')).toBeNull();
  });
});
