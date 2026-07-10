import { afterEach, describe, expect, it, vi } from 'vitest';
import { narrateTextStream, pronounceText } from './api';

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

describe('narrateTextStream', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('awaits chunk handling and rejects an error event', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"chunk","url":"/sessions/s/one.wav"}\n'));
        controller.enqueue(encoder.encode('{"type":"error","detail":"model failed"}\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body })));
    const onChunk = vi.fn(async () => {});

    await expect(narrateTextStream('text', 'session-1', 1, null, 'en', { onChunk }))
      .rejects.toThrow('model failed');
    expect(onChunk).toHaveBeenCalledTimes(2);
  });
});
