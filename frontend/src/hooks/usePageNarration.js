import { useCallback } from 'react';
import { cancelGeneration, narrateText } from '../utils/api';
import { stitchPartialTimings } from '../utils/timings';
import { cacheKey } from '../utils/pageAudioCache';

/**
 * Page narration: TTS requests, cache entries, partial voice-switch clips.
 */
export function usePageNarration({
    sessionId,
    activeVoiceRef,
    langRef,
    cacheRef,
    buildTimings,
}) {
    const narratePage = useCallback(
        async (pageNum, text, opts = {}) => {
            const {
                voiceId = activeVoiceRef.current,
                languageId = langRef.current,
                fromWord = 0,
                storeFullCache = true,
                priority = 'current',
            } = opts;

            const words = text.split(/\s+/).filter(Boolean);
            const start = Math.max(0, Math.min(fromWord, Math.max(0, words.length - 1)));
            const partial = start > 0;
            const narrateBody = partial ? words.slice(start).join(' ') : text;

            let result;
            try {
                result = await narrateText(
                    narrateBody,
                    sessionId,
                    pageNum,
                    voiceId,
                    languageId,
                    {
                        clipSuffix: partial ? String(start) : null,
                        priority: partial ? 'interactive' : priority,
                    }
                );
            } catch (err) {
                if (err.isSuperseded) return null; // silently drop superseded work
                throw err;
            }

            const duration = result.duration_s || 0;
            let built = await buildTimings(
                narrateBody,
                result.segments,
                duration,
                result.audioUrl,
                result.word_timings
            );

            let fullWords = words;
            let fullTimes = built.times;
            if (partial) {
                fullTimes = stitchPartialTimings(words, start, built.times);
                built = { words: fullWords, times: fullTimes };
            }

            const entry = {
                status: 'ready',
                page: pageNum,
                voiceId: voiceId ?? null,
                languageId,
                text,
                audioUrl: result.audioUrl,
                segments: result.segments || [],
                duration_s: duration,
                words: built.words,
                times: built.times,
                fromWord: start,
                partial,
            };

            if (storeFullCache && !partial) {
                cacheRef.current.set(cacheKey(pageNum, voiceId, languageId), entry);
            }
            return entry;
        },
        [activeVoiceRef, buildTimings, cacheRef, langRef, sessionId]
    );

    /**
     * Tell the server to abort in-flight generation (page change / voice switch /
     * document close). Fire-and-forget; prefetch already bumps its own generation.
     */
    const cancelGenerationOnServer = useCallback(() => {
        cancelGeneration();
    }, []);

    return { narratePage, cancelGeneration: cancelGenerationOnServer };
}
