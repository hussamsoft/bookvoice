import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bookAudiobookContentUrl,
  cancelBookAudiobook,
  claimLegacyStudioProjects,
  createBookAudiobook,
  createStudioNarration,
  createStudioProject,
  exportCachedAudio,
  getBookAudiobook,
  getBookPage,
  getPreparedBook,
  getStudioWorkspace,
  narrateTextStream,
  openStudioProjectFolder,
  pronounceText,
  uploadStudioSource,
  waitForStudioJob,
} from './api';

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

  it('sends a request id for targeted cancellation', async () => {
    const body = new ReadableStream({ start(controller) { controller.close(); } });
    const fetchMock = vi.fn(async () => ({ ok: true, body }));
    vi.stubGlobal('fetch', fetchMock);

    await narrateTextStream('text', 'session-1', 1, null, 'en', { requestId: 'request_1' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).request_id).toBe('request_1');
  });
});

describe('exportCachedAudio', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests an inclusive page range and returns a usable audio URL', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ audio_url: '/sessions/s/export.wav', pages: [1, 2], duration_s: 4 }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportCachedAudio('session-1', 1, 2);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      session_id: 'session-1', start_page: 1, end_page: 2,
    });
    expect(result.pages).toEqual([1, 2]);
    expect(result.audioUrl).toContain('/sessions/s/export.wav');
  });
});

describe('getPreparedBook', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads the current manifest so preparation can resume missing text pages', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'book', pageHashes: { '1.json': 'hash' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getPreparedBook('book');

    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/books\/book$/));
    expect(result.pageHashes).toEqual({ '1.json': 'hash' });
  });
});

describe('getBookPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches a source page for text books', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ page: 4, text: 'Chapter text' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getBookPage('book-1', 4);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/books\/book-1\/pages\/4$/));
    expect(result).toEqual({ page: 4, text: 'Chapter text' });
  });

  it('maps a missing page to null and other failures to an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    await expect(getBookPage('book-1', 99)).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(getBookPage('book-1', 2)).rejects.toThrow('Could not load page 2.');
  });
});

describe('audiobook export', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts an export job for a voice profile', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ jobId: 'job-9', status: 'QUEUED', pageCount: 12 }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createBookAudiobook('book-1', 'a'.repeat(20));

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/books\/book-1\/audiobooks$/);
    expect(JSON.parse(options.body)).toEqual({ profileId: 'a'.repeat(20) });
    expect(result.jobId).toBe('job-9');
  });

  it('polls job progress and builds the one-shot content URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'job-9', status: 'RUNNING', pagesDone: 3, pageCount: 12 }),
    })));

    const status = await getBookAudiobook('book-1', 'job-9');

    expect(status.pagesDone).toBe(3);
    expect(bookAudiobookContentUrl('book-1', 'job-9')).toMatch(
      /\/books\/book-1\/audiobooks\/job-9\/content$/,
    );
  });

  it('tolerates a missing job when cancelling a finished export', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cancelBookAudiobook('book-1', 'gone')).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });
});

describe('Voice Studio API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a persistent project with the requested name', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'project-1', name: 'Voice work' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await createStudioProject('Voice work');

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/studio\/projects$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: 'Voice work' });
    expect(fetchMock.mock.calls[0][1].headers['X-BookVoice-Device-ID'])
      .toMatch(/^[0-9a-f]{32}$/);
  });

  it('reports only this device workspace and whether earlier projects can be claimed', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        projects: [{ id: 'project-1' }],
        legacyProjectsAvailable: true,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getStudioWorkspace()).resolves.toEqual({
      projects: [{ id: 'project-1' }],
      legacyProjectsAvailable: true,
    });
  });

  it('claims earlier shared projects for the current device once', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        claimed: 2,
        projects: [{ id: 'project-1' }, { id: 'project-2' }],
        legacyProjectsAvailable: false,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await claimLegacyStudioProjects();

    expect(result.claimed).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/studio\/legacy-projects\/claim$/),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-BookVoice-Device-ID': expect.stringMatching(/^[0-9a-f]{32}$/),
        }),
      }),
    );
  });

  it('submits typed narration with the full advanced-settings contract', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'job-1', status: 'QUEUED' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const settings = { pace: 1.1, expression: 0.7, temperature: 0.9, guidance: 0.3, seed: 42 };

    await createStudioNarration('project-1', {
      text: 'Written in the app.', languageId: 'en', voiceId: 'aria', generationSettings: settings,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe('Written in the app.');
    expect(body.generationSettings).toEqual(settings);
  });

  it('marks microphone recordings so the server can enforce 30-day retention', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'job-1', status: 'QUEUED' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['recording'], 'recording.wav', { type: 'audio/wav' });

    await uploadStudioSource('project-1', file, { captureMethod: 'recording' });

    const form = fetchMock.mock.calls[0][1].body;
    expect(form.get('captureMethod')).toBe('recording');
    expect(form.get('file').name).toBe('recording.wav');
  });

  it('returns a completed job without unnecessary polling', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'job-1', status: 'COMPLETED', result: { outputId: 'out' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const job = await waitForStudioJob('job-1', { intervalMs: 1 });

    expect(job.result.outputId).toBe('out');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens the complete managed project folder', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ opened: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await openStudioProjectFolder('project-1');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/studio\/projects\/project-1\/open-folder$/),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-BookVoice-Device-ID': expect.stringMatching(/^[0-9a-f]{32}$/),
        }),
      }),
    );
  });
});
