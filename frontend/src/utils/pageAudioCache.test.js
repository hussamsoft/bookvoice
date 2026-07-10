import { describe, it, expect } from 'vitest';
import { createPageAudioCache, cacheKey } from './pageAudioCache';

describe('pageAudioCache', () => {
  it('retains only pages in the window', () => {
    const c = createPageAudioCache({ maxEntries: 20 });
    for (let p = 1; p <= 10; p++) {
      c.set(cacheKey(p, 'v', 'en'), { status: 'ready', audioUrl: `u${p}`, page: p });
    }
    c.retainPageWindow(4, 8);
    expect(c.hasReady(cacheKey(4, 'v', 'en'))).toBe(true);
    expect(c.hasReady(cacheKey(8, 'v', 'en'))).toBe(true);
    expect(c.hasReady(cacheKey(3, 'v', 'en'))).toBe(false);
    expect(c.hasReady(cacheKey(9, 'v', 'en'))).toBe(false);
  });

  it('evicts oldest when over maxEntries', () => {
    const c = createPageAudioCache({ maxEntries: 3 });
    c.set(cacheKey(1, null, 'en'), { status: 'ready', audioUrl: 'a' });
    c.set(cacheKey(2, null, 'en'), { status: 'ready', audioUrl: 'b' });
    c.set(cacheKey(3, null, 'en'), { status: 'ready', audioUrl: 'c' });
    c.set(cacheKey(4, null, 'en'), { status: 'ready', audioUrl: 'd' });
    expect(c.size()).toBe(3);
    expect(c.hasReady(cacheKey(1, null, 'en'))).toBe(false);
    expect(c.hasReady(cacheKey(4, null, 'en'))).toBe(true);
  });
});
