import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPanel from './SettingsPanel';
import { ToastProvider } from './Toast';
import { getTtsStatus } from '../utils/api';

vi.mock('../utils/api', () => ({
  getTtsStatus: vi.fn(async () => ({ status: 'loading' })),
  reloadTtsModel: vi.fn(),
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
});
