import { describe, expect, it } from 'vitest';
import { shouldDisableNarrationStart } from './readerPlaybackState';

describe('shouldDisableNarrationStart', () => {
    const ready = {
        isPlaying: false,
        modelError: false,
        modelReady: true,
        isOcring: false,
        isGenerating: false,
    };

    it('blocks a new start while narration is still generating even if an audio element has a source', () => {
        expect(shouldDisableNarrationStart({ ...ready, isGenerating: true })).toBe(true);
    });

    it('keeps pause available for narration that is already playing', () => {
        expect(shouldDisableNarrationStart({ ...ready, isGenerating: true, isPlaying: true })).toBe(false);
    });
});
