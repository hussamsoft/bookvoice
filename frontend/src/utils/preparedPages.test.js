import { describe, expect, it } from 'vitest';
import {
  activePreparedProfile,
  missingPreparedTextPages,
  preparationForActiveProfile,
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
