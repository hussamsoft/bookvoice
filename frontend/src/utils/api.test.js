import { afterEach, describe, expect, it, vi } from 'vitest';
import { pronounceText } from './api';

describe('pronounceText', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the pronunciation contract without a page index', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ audio_url: '/sessions/s/clip.wav' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await pronounceText('hello', 'session-1', 'voice-a', 'en');

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      text: 'hello',
      session_id: 'session-1',
      language_id: 'en',
      voice_id: 'voice-a',
    });
    expect(body).not.toHaveProperty('page_index');
  });
});
