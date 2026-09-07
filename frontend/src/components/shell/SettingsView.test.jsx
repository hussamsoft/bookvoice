import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsView from './SettingsView';
import { ToastProvider } from '../Toast';
import { getServerAddresses, getTtsStatus } from '../../utils/api';

const updateConfig = vi.fn();

vi.mock('../../utils/api', () => ({
  getTtsStatus: vi.fn(async () => ({ status: 'loading' })),
  reloadTtsModel: vi.fn(),
  getServerAddresses: vi.fn(async () => ({ available: false })),
}));

vi.mock('../../hooks/useUserConfig', () => ({
  useUserConfig: () => ({
    config: { tts_device: 'auto', ocr_use_gpu: false, voice_id: null, check_for_updates: true },
    updateConfig,
  }),
}));

function renderSettings() {
  return render(
    <ToastProvider>
      <SettingsView />
    </ToastProvider>
  );
}

describe('SettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('labels its sections so scope is obvious', () => {
    renderSettings();
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Narration' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Capture & OCR' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Device & connections' })).toBeInTheDocument();
  });

  it('offers every palette in both modes with the active one pressed', () => {
    localStorage.setItem('bookvoice.palette', 'plum');
    localStorage.setItem('bookvoice.mode', 'dark');
    renderSettings();

    const group = screen.getByRole('group', { name: 'Color palette' });
    const active = within(group).getAllByRole('button', { pressed: true });
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute('title')).toBe('Violet Dusk (dark)');

    fireEvent.click(within(group).getByRole('button', { title: 'Moss Glow (light)' }));
    expect(document.documentElement).toHaveAttribute('data-palette', 'sage');
    expect(document.documentElement).toHaveAttribute('data-mode', 'light');
  });

  it('saves engine changes to the device config', async () => {
    updateConfig.mockResolvedValue(undefined);
    renderSettings();

    fireEvent.change(screen.getByDisplayValue('Auto'), { target: { value: 'cpu' } });
    await act(async () => {});
    expect(updateConfig).toHaveBeenCalledWith({ tts_device: 'cpu' });
  });

  it('lists the addresses other devices can open once published', async () => {
    getServerAddresses.mockResolvedValue({
      available: true,
      port: 8123,
      lan: true,
      addresses: ['192.168.1.81'],
      tunnelUrl: 'https://bookvoice.example.com',
    });
    renderSettings();

    expect(await screen.findByText('Open on another device')).toBeTruthy();
    expect(screen.getByText('http://192.168.1.81:8123')).toBeTruthy();
    expect(screen.getByText('https://bookvoice.example.com')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
  });

  it('omits the device section when the server is loopback-only', async () => {
    getServerAddresses.mockResolvedValue({ available: true, port: 8000, addresses: [] });
    renderSettings();

    await act(async () => {});
    expect(screen.queryByText('Open on another device')).toBeNull();
  });
});
