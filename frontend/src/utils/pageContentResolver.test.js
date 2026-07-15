import { describe, expect, it, vi } from 'vitest';
import { preparedPageAudioEntry, resolvePageContent } from './pageContentResolver';

describe('resolvePageContent', () => {
  it('uses prepared page text before attempting PDF extraction', async () => {
    const getPreparedPage = vi.fn(async () => ({
      text: 'Already prepared text',
      audioUrl: '/api/books/book/profiles/profile/pages/1/audio',
    }));
    const preparePageText = vi.fn(async () => 'Slow OCR text');

    const result = await resolvePageContent({
      bookId: 'book',
      profileId: 'profile',
      page: 1,
      getPreparedPage,
      preparePageText,
    });

    expect(result).toEqual({
      text: 'Already prepared text',
      prepared: {
        text: 'Already prepared text',
        audioUrl: '/api/books/book/profiles/profile/pages/1/audio',
      },
      source: 'prepared',
    });
    expect(preparePageText).not.toHaveBeenCalled();
  });

  it('falls back to PDF extraction when prepared metadata is unavailable', async () => {
    const getPreparedPage = vi.fn(async () => null);
    const preparePageText = vi.fn(async () => 'Extracted PDF text');

    const result = await resolvePageContent({
      bookId: 'book',
      profileId: 'profile',
      page: 2,
      getPreparedPage,
      preparePageText,
    });

    expect(result).toEqual({
      text: 'Extracted PDF text',
      prepared: null,
      source: 'pdf',
    });
    expect(preparePageText).toHaveBeenCalledWith(2);
  });

  it('falls back to the PDF when the prepared library request fails', async () => {
    const getPreparedPage = vi.fn(async () => {
      throw new Error('library unavailable');
    });
    const preparePageText = vi.fn(async () => 'Extracted PDF text');

    const result = await resolvePageContent({
      bookId: 'book',
      profileId: 'profile',
      page: 3,
      getPreparedPage,
      preparePageText,
    });

    expect(result.source).toBe('pdf');
    expect(result.text).toBe('Extracted PDF text');
  });
});

describe('preparedPageAudioEntry', () => {
  it('converts persisted prepared audio into a ready reader entry', () => {
    expect(preparedPageAudioEntry({
      prepared: {
        audioUrl: '/api/books/book/profiles/profile/pages/2/audio',
        audio: { duration: 12.5 },
        wordTimings: [
          { word: 'Already', start_s: 0, end_s: 0.7 },
          { word: 'prepared', start_s: 0.71, end_s: 1.4 },
        ],
      },
      text: 'Already prepared',
      page: 2,
      voiceId: 'aria',
      languageId: 'en',
    })).toMatchObject({
      status: 'ready',
      page: 2,
      voiceId: 'aria',
      languageId: 'en',
      audioUrl: '/api/books/book/profiles/profile/pages/2/audio',
      duration_s: 12.5,
      words: ['Already', 'prepared'],
      times: [0, 0.71],
      ends: [0.7, 1.4],
      timingMode: 'aligned',
      partial: false,
    });
  });

  it('returns null when the prepared page has no durable narration', () => {
    expect(preparedPageAudioEntry({
      prepared: { text: 'Only text was saved' },
      text: 'Only text was saved',
      page: 1,
      voiceId: null,
      languageId: 'en',
    })).toBeNull();
  });
});
