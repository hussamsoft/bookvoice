import { useCallback, useEffect, useRef } from 'react';
import { cacheKey } from '../utils/pageAudioCache';

export const PREFETCH_AHEAD = 2;
export const PREFETCH_BEHIND = 1;

/**
 * Background prefetch queue for adjacent PDF pages.
 */
export function usePrefetch({
    cacheRef,
    activeVoiceRef,
    langRef,
    modelReady,
    isGeneratingRef,
    preparePageText,
    narratePage,
    setPrefetchHint,
}) {
    const prefetchBusyRef = useRef(false);
    const prefetchQueueRef = useRef([]);
    const generationRef = useRef(0);
    const timerRef = useRef(0);

    const cancelPrefetch = useCallback(() => {
        generationRef.current += 1;
        prefetchQueueRef.current = [];
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = 0;
        }
        setPrefetchHint('');
    }, [setPrefetchHint]);

    const runPrefetchQueue = useCallback(async () => {
        if (prefetchBusyRef.current) {
            if (!timerRef.current) {
                timerRef.current = setTimeout(() => {
                    timerRef.current = 0;
                    runPrefetchQueue();
                }, 500);
            }
            return;
        }
        prefetchBusyRef.current = true;
        try {
            while (prefetchQueueRef.current.length) {
                if (isGeneratingRef.current) {
                    await new Promise((r) => setTimeout(r, 500));
                    continue;
                }
                const job = prefetchQueueRef.current.shift();
                if (!job) break;
                const { page, voiceId, languageId, generation } = job;
                if (generation !== generationRef.current) continue;
                const key = cacheKey(page, voiceId, languageId);
                if (cacheRef.current.hasReady(key)) continue;
                try {
                    setPrefetchHint(`Warming page ${page}…`);
                    const text = await preparePageText(page, { quiet: true });
                    if (generation !== generationRef.current) continue;
                    if (isGeneratingRef.current) {
                        prefetchQueueRef.current.unshift(job);
                        await new Promise((r) => setTimeout(r, 500));
                        continue;
                    }
                    const entry = await narratePage(page, text, {
                        voiceId,
                        languageId,
                        fromWord: 0,
                        storeFullCache: false,
                        priority: 'prefetch',
                    });
                    if (generation === generationRef.current) {
                        cacheRef.current.set(key, entry);
                    }
                } catch {
                    /* prefetch is best-effort */
                }
            }
        } finally {
            prefetchBusyRef.current = false;
            setPrefetchHint('');
        }
    }, [
        cacheRef,
        isGeneratingRef,
        narratePage,
        preparePageText,
        setPrefetchHint,
    ]);

    const schedulePrefetch = useCallback(
        (centerPage, total) => {
            if (!modelReady || !total) return;
            cancelPrefetch();
            const generation = generationRef.current;
            const voiceId = activeVoiceRef.current;
            const languageId = langRef.current;
            const lo = Math.max(1, centerPage - PREFETCH_BEHIND);
            const hi = Math.min(total, centerPage + PREFETCH_AHEAD);
            cacheRef.current.retainPageWindow(lo, hi);

            const order = [];
            for (let d = 1; d <= PREFETCH_AHEAD; d++) {
                if (centerPage + d <= total) order.push(centerPage + d);
            }
            for (let d = 1; d <= PREFETCH_BEHIND; d++) {
                if (centerPage - d >= 1) order.push(centerPage - d);
            }

            const q = [];
            for (const p of order) {
                const key = cacheKey(p, voiceId, languageId);
                if (!cacheRef.current.hasReady(key)) {
                    q.push({ page: p, voiceId, languageId, generation });
                }
            }
            prefetchQueueRef.current = q;
            timerRef.current = setTimeout(() => {
                timerRef.current = 0;
                runPrefetchQueue();
            }, 3000);
        },
        [activeVoiceRef, cacheRef, cancelPrefetch, langRef, modelReady, runPrefetchQueue]
    );

    useEffect(
        () => () => {
            generationRef.current += 1;
            prefetchQueueRef.current = [];
            if (timerRef.current) clearTimeout(timerRef.current);
        },
        []
    );

    return { cancelPrefetch, schedulePrefetch, runPrefetchQueue, prefetchQueueRef };
}
