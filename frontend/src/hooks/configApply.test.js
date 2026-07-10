/**
 * Regression: saved config is applied once; a user interaction before a late
 * config response must not be overwritten.
 *
 * Mirrors the configAppliedRef pattern used by BookSession and PdfViewer.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/api', () => ({
  getUserConfig: vi.fn(),
  saveUserConfig: vi.fn(),
}));

import { getUserConfig, saveUserConfig } from '../utils/api';
import { useUserConfig } from './useUserConfig';

function useSessionLikeSettings() {
  const { config, updateConfig } = useUserConfig();
  const [activeVoiceId, setActiveVoiceId] = useState(null);
  const [targetLanguage, setTargetLanguage] = useState('en');
  const configAppliedRef = useRef(false);
  const userTouchedRef = useRef({ voice: false, language: false });

  useEffect(() => {
    if (config && !configAppliedRef.current) {
      configAppliedRef.current = true;
      if (!userTouchedRef.current.voice && config.voice_id) {
        setActiveVoiceId(config.voice_id);
      }
      if (!userTouchedRef.current.language && config.language_id) {
        setTargetLanguage(config.language_id);
      }
    }
  }, [config]);

  const handleVoiceChange = (id) => {
    userTouchedRef.current.voice = true;
    setActiveVoiceId(id);
    updateConfig({ voice_id: id });
  };

  return { activeVoiceId, targetLanguage, handleVoiceChange, config };
}

describe('config apply-once semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveUserConfig.mockResolvedValue({ version: '1.7.0', config: {} });
  });

  it('applies saved voice and language once config arrives', async () => {
    let resolveConfig;
    getUserConfig.mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      })
    );

    const { result } = renderHook(() => useSessionLikeSettings());
    expect(result.current.activeVoiceId).toBeNull();

    await act(async () => {
      resolveConfig({
        version: '1.7.0',
        config: { voice_id: 'Ryan', language_id: 'ar' },
      });
    });

    await waitFor(() => {
      expect(result.current.activeVoiceId).toBe('Ryan');
      expect(result.current.targetLanguage).toBe('ar');
    });
  });

  it('does not overwrite a user selection made before late config arrives', async () => {
    let resolveConfig;
    getUserConfig.mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      })
    );

    const { result } = renderHook(() => useSessionLikeSettings());

    // User picks a voice before config returns.
    await act(async () => {
      result.current.handleVoiceChange('Aria');
    });
    expect(result.current.activeVoiceId).toBe('Aria');

    // Late config would otherwise clobber Aria with Ryan.
    await act(async () => {
      resolveConfig({
        version: '1.7.0',
        config: { voice_id: 'Ryan', language_id: 'en' },
      });
    });

    await waitFor(() => {
      expect(result.current.config).not.toBeNull();
    });

    // Apply-once guard: user selection stands.
    expect(result.current.activeVoiceId).toBe('Aria');
  });
});
