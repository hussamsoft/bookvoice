import { useCallback, useRef } from 'react';
import {
    estimateWordTimings,
    estimateWordTimingsFromSegments,
    highlightLagMs,
    timesFromWordTimings,
    wordIndexAtTime,
} from '../utils/timings';
import { detectSpeechOnset, shiftTimingsToOnset } from '../utils/audioOnset';
import {
    applyWordHighlight,
    buildWordSpanMap,
    splitTextLayerWordRuns,
} from '../utils/pdfHighlight';

/**
 * Word-level highlight sync for PDF narration playback.
 */
export function useWordHighlight({
    containerRef,
    langRef,
    audioRef,
    setCurrentWord,
    currentWordRef,
    pageWordsRef,
    wordTimesRef,
    wordEndsRef,
    audioTimeOffsetRef,
    viewPageRef,
    audioPageRef,
}) {
    const wordSpanMapRef = useRef([]);
    const prevHighlightSpanRef = useRef(null);
    const rafRef = useRef(0);

    const rebindWordSpans = useCallback(() => {
        const textLayer = containerRef.current?.querySelector(
            '.react-pdf__Page__textContent'
        );
        if (!textLayer || !pageWordsRef.current.length) {
            wordSpanMapRef.current = [];
            return;
        }
        splitTextLayerWordRuns(textLayer);
        wordSpanMapRef.current = buildWordSpanMap(pageWordsRef.current, textLayer);
    }, [containerRef, pageWordsRef]);

    const buildTimings = useCallback(
        async (text, segments, duration, audioUrlForOnset, wordTimings = []) => {
            const forced = timesFromWordTimings(wordTimings, text);
            if (forced.times.length) {
                return { ...forced, mode: 'aligned' };
            }

            let { words, times } = estimateWordTimingsFromSegments(
                text,
                segments,
                langRef.current,
                duration
            );
            if (!words.length) {
                words = text.split(/\s+/).filter(Boolean);
                times = estimateWordTimings(words, duration, langRef.current);
            }
            if (audioUrlForOnset && times.length) {
                const onset = await detectSpeechOnset(audioUrlForOnset);
                if (onset > 0.01) {
                    times = shiftTimingsToOnset(times, onset, duration || Infinity);
                }
            }
            return { words, times, ends: [], mode: 'estimate' };
        },
        [langRef]
    );

    const syncHighlightAt = useCallback(
        (localTime) => {
            const lag = highlightLagMs(langRef.current);
            const offset = audioTimeOffsetRef ? audioTimeOffsetRef.current : 0;
            const globalTime = localTime + offset;
            const idx = wordIndexAtTime(
                wordTimesRef.current,
                globalTime,
                lag,
                wordEndsRef?.current
            );
            if (idx !== currentWordRef.current) {
                currentWordRef.current = idx;
                setCurrentWord(idx);
            }
            const textLayer = containerRef.current?.querySelector(
                '.react-pdf__Page__textContent'
            );
            const viewingNarratedPage =
                !viewPageRef || !audioPageRef || viewPageRef.current === audioPageRef.current;
            if (textLayer && wordSpanMapRef.current.length) {
                applyWordHighlight(
                    textLayer,
                    wordSpanMapRef.current,
                    viewingNarratedPage ? idx : -1,
                    prevHighlightSpanRef
                );
            }
        },
        [
            audioTimeOffsetRef,
            containerRef,
            currentWordRef,
            langRef,
            setCurrentWord,
            wordTimesRef,
            wordEndsRef,
            viewPageRef,
            audioPageRef,
        ]
    );

    const startHighlightLoop = useCallback(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        const tick = () => {
            const audio = audioRef.current;
            if (!audio || audio.paused || audio.ended) {
                rafRef.current = 0;
                return;
            }
            syncHighlightAt(audio.currentTime);
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
    }, [audioRef, syncHighlightAt]);

    const stopHighlightLoop = useCallback(() => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
        }
    }, []);

    return {
        wordSpanMapRef,
        prevHighlightSpanRef,
        rafRef,
        rebindWordSpans,
        buildTimings,
        syncHighlightAt,
        startHighlightLoop,
        stopHighlightLoop,
    };
}
