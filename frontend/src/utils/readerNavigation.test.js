import { describe, expect, it } from 'vitest';
import { shouldDisableFollowNarration } from './readerNavigation';

describe('shouldDisableFollowNarration', () => {
    it('turns following off when a playing narration is browsed away from', () => {
        expect(
            shouldDisableFollowNarration({
                isPlaying: true,
                narratedPage: 3,
                targetPage: 4,
            })
        ).toBe(true);
    });

    it('keeps following on when returning to the narrated page or while paused', () => {
        expect(
            shouldDisableFollowNarration({
                isPlaying: true,
                narratedPage: 3,
                targetPage: 3,
            })
        ).toBe(false);
        expect(
            shouldDisableFollowNarration({
                isPlaying: false,
                narratedPage: 3,
                targetPage: 4,
            })
        ).toBe(false);
    });
});
