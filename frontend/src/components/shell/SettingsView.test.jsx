import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsView from './SettingsView';
import { getServerAddresses } from '../../utils/api';
import { ToastProvider } from '../Toast';

const updateConfig = vi.fn();

const signOutMock = vi.fn(async () => undefined);

vi.mock('../../utils/api', () => ({
  getTtsStatus: vi.fn(async () => ({ status: 'loading' })),
  reloadTtsModel: vi.fn(),
  getServerAddresses: vi.fn(async () => ({ available: false })),
  signOut: (...args) => signOutMock(...args),
}));

const DEFAULT_CONFIG = { tts_device: 'auto', ocr_use_gpu: false, voice_id: null, check_for_updates: true };
let mockConfig = DEFAULT_CONFIG;
vi.mock('../../hooks/useUserConfig', () => ({
  useUserConfig: () => ({
    config: mockConfig,
    updateConfig,
    saveError: null,
  }),
}));

const capabilityState = vi.hoisted(() => ({ serverMode: false }));
vi.mock('../../hooks/useCapabilities', () => ({
  useCapabilities: () => ({
    serverMode: capabilityState.serverMode,
    localFileActions: !capabilityState.serverMode,
    authRequired: false,
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
    mockConfig = DEFAULT_CONFIG;
    capabilityState.serverMode = false;
    signOutMock.mockClear();
  });

  it('announces loading exactly once while config is pending (F-41)', () => {
    mockConfig = null;
    renderSettings();
    const statuses = screen.getAllByRole('status');
    const loading = statuses.filter((el) => /Loading settings/.test(el.textContent));
    expect(loading.length).toBe(1);
  });

  it('labels intent-based sections', () => {
    renderSettings();
    expect(screen.getByRole('heading', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Narration' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Capture & OCR' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Device & connections' })).toBeInTheDocument();
  });

  it('offers Paper, Night, and System as one radio group', () => {
    renderSettings();
    const group = screen.getByRole('radiogroup', { name: 'Reading mode' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: 'Paper' })).toHaveAttribute('aria-checked', 'true');
    expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
  });

  it('selects Night and follows System when requested', () => {
    renderSettings();
    const group = screen.getByRole('radiogroup', { name: 'Reading mode' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Night' }));
    expect(document.documentElement).toHaveAttribute('data-mode', 'dark');
    expect(localStorage.getItem('bookvoice.mode')).toBe('dark');
    fireEvent.click(within(group).getByRole('radio', { name: 'System' }));
    expect(localStorage.getItem('bookvoice.mode')).toBe('system');
  });

  it('moves mode selection with arrow keys', () => {
    renderSettings();
    const group = screen.getByRole('radiogroup', { name: 'Reading mode' });
    const current = within(group).getByRole('radio', { name: 'Paper' });
    fireEvent.keyDown(current, { key: 'ArrowRight' });
    expect(within(group).getByRole('radio', { name: 'Night' })).toHaveFocus();
    expect(document.documentElement).toHaveAttribute('data-mode', 'dark');
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

  it('offers sign-out only for hosted sessions', async () => {
    capabilityState.serverMode = true;
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await act(async () => {});
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });
});
