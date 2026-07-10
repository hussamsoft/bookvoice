/**
 * Estimate per-word start times for TTS playback highlighting.
 *
 * Prefer estimateWordTimingsFromSegments() when the backend returns real
 * per-chunk audio durations — that keeps drift local to each phrase.
 */

export function estimateWordTimings(words, duration, languageId = 'en') {
    if (!words?.length || !duration || duration <= 0) {
        return [];
    }

    const lang = (languageId || 'en').toLowerCase();
    const weights = words.map((word) => wordWeight(word, lang));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0) || 1;

    // Chatterbox: almost no head silence after onset correction; keep residual tiny.
    const leadIn = Math.min(0.04, duration * 0.008);
    const trail = Math.min(0.12, duration * 0.015);
    const usable = Math.max(duration - leadIn - trail, duration * 0.96);

    let t = leadIn;
    return weights.map((w) => {
        const start = t;
        t += (w / totalWeight) * usable;
        return start;
    });
}

/**
 * Build absolute word start times using measured chunk durations.
 *
 * @param {string} pageText
 * @param {{ text: string, start_s: number, end_s: number }[]} segments
 * @param {string} languageId
 * @param {number} [fallbackDuration]
 */
export function estimateWordTimingsFromSegments(
    pageText,
    segments,
    languageId = 'en',
    fallbackDuration = 0
) {
    const words = String(pageText || '')
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length) return { words: [], times: [] };

    if (!segments?.length) {
        const times = estimateWordTimings(words, fallbackDuration, languageId);
        return { words, times };
    }

    const times = new Array(words.length).fill(0);
    let wordOffset = 0;
    let aligned = 0;

    for (const seg of segments) {
        const segWords = String(seg.text || '')
            .split(/\s+/)
            .filter(Boolean);
        if (!segWords.length) continue;

        const start = Number(seg.start_s) || 0;
        const end = Number(seg.end_s);
        const dur =
            Number.isFinite(end) && end > start
                ? end - start
                : Math.max(0.05, (fallbackDuration || 0) / segments.length);

        const local = estimateWordTimings(segWords, dur, languageId);
        for (let i = 0; i < local.length; i++) {
            const globalIdx = wordOffset + i;
            if (globalIdx >= words.length) break;
            times[globalIdx] = start + local[i];
            aligned++;
        }
        wordOffset += segWords.length;
    }

    if (aligned < words.length * 0.85 || wordOffset !== words.length) {
        const lastEnd = Math.max(
            fallbackDuration || 0,
            ...segments.map((s) => Number(s.end_s) || 0)
        );
        return {
            words,
            times: estimateWordTimings(words, lastEnd || fallbackDuration, languageId),
        };
    }

    return { words, times };
}

/**
 * Build full-page timing array for a partial narration clip that starts at
 * `startWordIndex`. Words before the clip use a sentinel (-1) so
 * wordIndexAtTime never selects them while the partial audio plays from t=0.
 */
export function stitchPartialTimings(fullWords, startWordIndex, partialTimes) {
    const times = new Array(fullWords.length);
    for (let i = 0; i < fullWords.length; i++) {
        if (i < startWordIndex) {
            times[i] = -1;
        } else {
            const local = partialTimes[i - startWordIndex];
            times[i] = typeof local === 'number' ? local : 0;
        }
    }
    return times;
}

function wordWeight(word, lang) {
    const raw = String(word || '');
    const clean = raw.replace(/[^\p{L}\p{N}']/gu, '');
    const chars = Math.max(1, clean.length || raw.length || 1);

    let speech;
    if (lang === 'ar') {
        // Arabic TTS is more char-linear than English syllable timing.
        speech = Math.max(0.9, chars * 0.55);
    } else {
        const vowelGroups = clean.match(/[aeiouy]+/gi);
        const syllables = vowelGroups
            ? vowelGroups.length
            : Math.max(1, Math.ceil(chars / 3.2));
        // Calibrated toward Chatterbox: slightly longer short words, less
        // exaggerated sentence-final pauses than classic heuristics.
        speech = Math.max(0.7, syllables * 0.68 + chars * 0.14);
    }

    let pause = 0;
    if (/[.!?؟。…]$/.test(raw)) pause = 1.55;
    else if (/[,;:،؛]$/.test(raw)) pause = 0.72;
    else if (/[-–—]$/.test(raw)) pause = 0.4;
    else if (raw.endsWith('…')) pause = 1.35;

    // Function words tend to be shorter in continuous speech.
    if (
        lang !== 'ar' &&
        /^(a|an|the|of|to|in|on|at|for|and|or|but|is|are|was|were|be|as|by|with)$/i.test(
            clean
        )
    ) {
        speech *= 0.72;
    }

    return speech + pause;
}

export function estimateSentenceIndex(sentences, currentTime, duration) {
    if (!sentences?.length || !duration) return 0;
    const weights = sentences.map((s) => Math.max(1, s.length));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const leadIn = Math.min(0.04, duration * 0.008);
    const trail = Math.min(0.12, duration * 0.015);
    const usable = Math.max(duration - leadIn - trail, duration * 0.96);
    const progress = Math.min(1, Math.max(0, (currentTime - leadIn) / usable));
    let target = progress * total;
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
        acc += weights[i];
        if (acc >= target) return i;
    }
    return sentences.length - 1;
}

/**
 * Binary-search word index for a given audio time.
 * lagMs: positive = highlight slightly ahead of the ear (follow-along feel).
 * Calibrated ~25ms after onset correction.
 */
export function wordIndexAtTime(wordStartTimes, currentTime, lagMs = 25) {
    if (!wordStartTimes?.length) return -1;
    const t = Math.max(0, currentTime + lagMs / 1000);
    // Skip leading sentinel slots (partial clips mark pre-resume words as -1).
    let lo = 0;
    while (lo < wordStartTimes.length && wordStartTimes[lo] < 0) lo++;
    if (lo >= wordStartTimes.length) return -1;

    let hi = wordStartTimes.length - 1;
    let ans = lo;
    let left = lo;
    while (left <= hi) {
        const mid = (left + hi) >> 1;
        const v = wordStartTimes[mid];
        if (v < 0) {
            left = mid + 1;
            continue;
        }
        if (v <= t) {
            ans = mid;
            left = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}
