import { beforeEach, describe, expect, it } from 'vitest';
import {
  documentFingerprint,
  loadReadingProgress,
  saveReadingProgress,
  toggleBookmark,
} from './readingProgress';

describe('reading progress', () => {
  beforeEach(() => localStorage.clear());

  it('uses stable file metadata as the document identity', () => {
    const file = { name: 'book.pdf', size: 1234, lastModified: 55 };
    expect(documentFingerprint(file)).toBe(documentFingerprint(file));
    expect(documentFingerprint({ ...file, size: 1235 })).not.toBe(documentFingerprint(file));
  });

  it('round trips bounded reader state', () => {
    saveReadingProgress('doc', {
      page: 4,
      time: 12.5,
      zoom: 1.3,
      playbackRate: 1.25,
      bookmarks: [4, 9, 4],
    });
    expect(loadReadingProgress('doc')).toEqual({
      page: 4,
      time: 12.5,
      zoom: 1.3,
      playbackRate: 1.25,
      bookmarks: [4, 9],
    });
  });

  it('toggles bookmarks in page order', () => {
    expect(toggleBookmark([5, 2], 3)).toEqual([2, 3, 5]);
    expect(toggleBookmark([2, 3, 5], 3)).toEqual([2, 5]);
  });
});
