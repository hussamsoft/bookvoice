import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsView from './SettingsView';
import { ToastProvider } from '../Toast';
import { getServerAddresses } from '../../utils/api';

const updateConfig = vi.fn();

vi.mock('../../utils/api', () => ({
  getTtsStatus: vi.fn(async () => ({ status: 'loading' })),
  reloadTtsModel: vi.fn(),
  getServerAddresses: vi.fn(async () => ({ available: false })),
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

vi.mock('../../hooks/useCapabilities', () => ({
  useCapabilities: () => ({
    serverMode: false,
    localFileActions: true,
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
  });

  it('announces loading exactly once while config is pending (F-41)', () => {
    mockConfig = null;
    renderSettings();
    const statuses = screen.getAllByRole('status');
    const loading = statuses.filter((el) => /Loading settings/.test(el.textContent));
    expect(loading.length).toBe(1);
  });

  it('labels its sections so scope is obvious', () => {
    renderSettings();
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Narration' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Capture & OCR' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Device & connections' })).toBeInTheDocument();
  });

  // F-29 supersedes the old "active one pressed" contract: the palette set
  // is single-choice, so it is a radiogroup (one tab stop, arrows move
  // selection) instead of ten tabbable aria-pressed buttons.
  it('models palette+mode as one radiogroup with named options (F-29)', () => {
    localStorage.setItem('bookvoice.palette', 'plum');
    localStorage.setItem('bookvoice.mode', 'dark');
    renderSettings();

    const group = screen.getByRole('radiogroup', { name: 'Color palette and mode' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(10); // five palettes x both modes

    // Explicit accessible names — title-only naming is the last-resort
    // fallback and loses to the aria-hidden swatch contents.
    const selected = radios.filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAccessibleName('Violet Dusk, dark');
    expect(radios.some((r) => r.getAttribute('aria-label') === 'Aurora Ink, dark')).toBe(true);

    // One tab stop: only the selected radio is in tab order.
    expect(selected[0].tabIndex).toBe(0);
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it('arrow keys move palette selection (F-29)', () => {
    localStorage.setItem('bookvoice.palette', 'plum');
    localStorage.setItem('bookvoice.mode', 'dark');
    renderSettings();

    const group = screen.getByRole('radiogroup', { name: 'Color palette and mode' });
    const radios = within(group).getAllByRole('radio');
    const current = radios.find((r) => r.getAttribute('aria-checked') === 'true');
    expect(current).toHaveAccessibleName('Violet Dusk, dark');

    fireEvent.keyDown(current, { key: 'ArrowRight' });
    const next = radios[(radios.indexOf(current) + 1) % radios.length];
    expect(next).toHaveAccessibleName('Ember Dusk, light');
    expect(next).toHaveAttribute('aria-checked', 'true');
    expect(next).toHaveFocus();
    expect(document.documentElement).toHaveAttribute('data-palette', 'sand');
    expect(document.documentElement).toHaveAttribute('data-mode', 'light');

    fireEvent.keyDown(next, { key: 'ArrowLeft' });
    expect(current).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement).toHaveAttribute('data-palette', 'plum');
  });

  it('clicking a palette option still selects it', () => {
    renderSettings();
    const group = screen.getByRole('radiogroup', { name: 'Color palette and mode' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Moss Glow, light' }));
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
