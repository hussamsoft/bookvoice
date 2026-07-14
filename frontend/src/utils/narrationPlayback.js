import {
    estimateWordTimings,
    estimateWordTimingsFromSegments,
    timesFromWordTimings,
} from './timings';
import { detectSpeechOnset, shiftTimingsToOnset } from './audioOnset';

/**
 * Shared timing builder for PDF and camera playback.
 */
export async function buildTimingsFromEntry({
    text,
    segments = [],
    duration_s = 0,
    word_timings = [],
    audioUrl,
    languageId = 'en',
}) {
    const forced = timesFromWordTimings(word_timings, text);
    if (forced.times.length) {
        return { ...forced, mode: 'aligned' };
    }

    let { words, times } = estimateWordTimingsFromSegments(
        text,
        segments,
        languageId,
        duration_s
    );
    if (!words.length) {
        words = (text || '').split(/\s+/).filter(Boolean);
        times = estimateWordTimings(words, duration_s, languageId);
    }
    if (audioUrl && times.length) {
        const onset = await detectSpeechOnset(audioUrl);
        if (onset > 0.01) {
            times = shiftTimingsToOnset(times, onset, duration_s || Infinity);
        }
    }
    return { words, times, ends: [], mode: 'estimate' };
}
