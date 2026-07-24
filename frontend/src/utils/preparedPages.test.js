import { describe, expect, it } from 'vitest';
import {
  activePreparedProfile,
  missingPreparedTextPages,
  preparationForActiveProfile,
  preparedBookDetails,
  shouldAdoptPreparedProfile,
} from './preparedPages';

describe('missingPreparedTextPages', () => {
  it('returns only pages that are not already persisted', () => {
    expect(missingPreparedTextPages(5, {
      '1.json': 'hash-1',
      '3.json': 'hash-3',
      '5.json': 'hash-5',
    })).toEqual([2, 4]);
  });

  it('ignores malformed and out-of-range manifest entries', () => {
    expect(missingPreparedTextPages(2, {
      '../1.json': 'bad',
      '0.json': 'bad',
      '3.json': 'bad',
      'one.json': 'bad',
      '2.json': 'hash-2',
    })).toEqual([1]);
  });
});

describe('prepared book details', () => {
  it('summarizes resume page, bookmarks, and durable generated pages', () => {
    expect(preparedBookDetails({
      pageCount: 10,
      progress: { page: 4, bookmarks: [2, 7] },
      activeProfileId: 'p1',
      profiles: [{ id: 'p1', readyPages: [1, 2, 3] }],
    })).toEqual({
      pageCount: 10,
      resumePage: 4,
      bookmarks: [2, 7],
      preparedPages: 3,
    });
  });
});

describe('prepared-book profile state', () => {
  const book = {
    activeProfileId: 'aria-profile',
    pageCount: 2,
    profiles: [
      {
        id: 'aria-profile',
        voiceId: 'Aria',
        languageId: 'en',
        completedPages: [1, 2],
        readyPages: [1, 2],
      },
    ],
    preparation: {
      id: 'stale-default-job',
      profileId: 'default-profile',
      status: 'FAILED',
      completedPages: [],
      totalPages: 2,
      error: 'old failure',
    },
  };

  it('selects the manifest active profile and its voice metadata', () => {
    expect(activePreparedProfile(book)).toMatchObject({
      id: 'aria-profile',
      voiceId: 'Aria',
      languageId: 'en',
    });
  });

  it('does not display an unrelated failed preparation over completed audio', () => {
    expect(preparationForActiveProfile(book)).toMatchObject({
      profileId: 'aria-profile',
      status: 'COMPLETED',
      completedPages: [1, 2],
      totalPages: 2,
      error: null,
    });
  });

  it('keeps live preparation state when it belongs to the active profile', () => {
    const matching = {
      ...book,
      preparation: {
        id: 'aria-job',
        profileId: 'aria-profile',
        status: 'RUNNING',
        completedPages: [1],
        totalPages: 2,
        error: null,
      },
    };
    expect(preparationForActiveProfile(matching)).toBe(matching.preparation);
  });

  it('does not call corrupt manifest-only completion prepared', () => {
    const corrupt = {
      ...book,
      profiles: [{ ...book.profiles[0], readyPages: [] }],
    };
    expect(preparationForActiveProfile(corrupt)).toMatchObject({
      status: 'PAUSED',
      completedPages: [],
      totalPages: 2,
    });
  });
});

describe('shouldAdoptPreparedProfile', () => {
  const preparation = {
    profileId: 'profile-natural-en',
    voiceId: 'natural',
    languageId: 'en',
  };

  it('adopts a running preparation so finished pages play instead of regenerating', () => {
    expect(shouldAdoptPreparedProfile({
      preparation: { ...preparation, status: 'RUNNING', completedPages: [1, 2] },
      voiceId: 'natural',
      languageId: 'en',
    })).toBe(true);
  });

  it('adopts regardless of job status, because prepared pages stay prepared', () => {
    for (const status of ['QUEUED', 'RUNNING', 'PAUSED', 'FAILED', 'COMPLETED']) {
      expect(shouldAdoptPreparedProfile({
        preparation: { ...preparation, status },
        voiceId: 'natural',
        languageId: 'en',
      })).toBe(true);
    }
  });

  it('refuses a profile prepared with another voice', () => {
    expect(shouldAdoptPreparedProfile({
      preparation,
      voiceId: 'storyteller',
      languageId: 'en',
    })).toBe(false);
  });

  it('refuses a profile prepared in another language', () => {
    expect(shouldAdoptPreparedProfile({
      preparation,
      voiceId: 'natural',
      languageId: 'fr',
    })).toBe(false);
  });

  it('treats a missing language as English on both sides', () => {
    expect(shouldAdoptPreparedProfile({
      preparation: { profileId: 'p', voiceId: null },
      voiceId: null,
    })).toBe(true);
  });

  it('matches a default voice whether it is null or undefined', () => {
    expect(shouldAdoptPreparedProfile({
      preparation: { profileId: 'p', voiceId: null, languageId: 'en' },
      voiceId: undefined,
      languageId: 'en',
    })).toBe(true);
  });

  it('does not adopt a null voice preparation while a real voice is selected', () => {
    expect(shouldAdoptPreparedProfile({
      preparation: { profileId: 'p', voiceId: null, languageId: 'en' },
      voiceId: 'natural',
      languageId: 'en',
    })).toBe(false);
  });

  it('ignores a preparation with no profile yet', () => {
    expect(shouldAdoptPreparedProfile({ preparation: null, voiceId: 'natural' })).toBe(false);
    expect(shouldAdoptPreparedProfile({ preparation: { profileId: null }, voiceId: 'natural' })).toBe(false);
    expect(shouldAdoptPreparedProfile()).toBe(false);
  });
});
