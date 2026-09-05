import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPanel from './SettingsPanel';
import { ToastProvider } from './Toast';
import { getServerAddresses, getTtsStatus } from '../utils/api';

vi.mock('../utils/api', () => ({
  getTtsStatus: vi.fn(async () => ({ status: 'loading' })),
  reloadTtsModel: vi.fn(),
  getServerAddresses: vi.fn(async () => ({ available: false })),
}));

vi.mock('../hooks/useUserConfig', () => ({
  useUserConfig: () => ({
    config: { tts_device: 'auto', ocr_use_gpu: false, voice_id: null },
    updateConfig: vi.fn(),
  }),
}));

describe('SettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not create a second model-status polling loop while closed', async () => {
    render(
      <ToastProvider>
        <SettingsPanel />
      </ToastProvider>
    );

    await act(async () => {});
    expect(getTtsStatus).not.toHaveBeenCalled();
  });

  it('does not ask for server addresses while closed', async () => {
    render(
      <ToastProvider>
        <SettingsPanel />
      </ToastProvider>
    );

    await act(async () => {});
    expect(getServerAddresses).not.toHaveBeenCalled();
  });

  it('lists the addresses other devices can open once published', async () => {
    getServerAddresses.mockResolvedValue({
      available: true,
      port: 8123,
      lan: true,
      addresses: ['192.168.1.81'],
      tunnelUrl: 'https://bookvoice.example.com',
    });
    render(
      <ToastProvider>
        <SettingsPanel />
      </ToastProvider>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    });

    expect(await screen.findByText('Open on another device')).toBeTruthy();
    expect(screen.getByText('http://192.168.1.81:8123')).toBeTruthy();
    expect(screen.getByText('https://bookvoice.example.com')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
  });

  it('omits the device section when the server is loopback-only', async () => {
    getServerAddresses.mockResolvedValue({ available: true, port: 8000, addresses: [] });
    render(
      <ToastProvider>
        <SettingsPanel />
      </ToastProvider>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    });

    await act(async () => {});
    expect(screen.queryByText('Open on another device')).toBeNull();
  });
});
