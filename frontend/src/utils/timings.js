/**
 * Estimate per-word start times for TTS playback highlighting.
 *
 * Prefer estimateWordTimingsFromSegments() when the backend returns real
 * per-chunk audio durations — that keeps drift local to each phrase instead
 * of accumulating across an entire page.
 */

export function estimateWordTimings(words, duration, languageId = 'en') {
    if (!words?.length || !duration || duration <= 0) {
        return [];
    }

    const lang = (languageId || 'en').toLowerCase();
    const weights = words.map((word) => wordWeight(word, lang));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0) || 1;

    // Chatterbox has very little silence at the head; keep lead-in tiny so the
    // first word highlights with the first audible phoneme.
    const leadIn = Math.min(0.08, duration * 0.01);
    const trail = Math.min(0.18, duration * 0.02);
    const usable = Math.max(duration - leadIn - trail, duration * 0.94);

    let t = leadIn;
    return weights.map((w) => {
        const start = t;
        t += (w / totalWeight) * usable;
        return start;
    });
}

/**
 * Build absolute word start times using measured chunk durations from the TTS
 * pipeline. Falls back to a single full-duration estimate on mismatch.
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

    // If chunking split words differently than a full-page split, fall back.
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

function wordWeight(word, lang) {
    const raw = String(word || '');
    const clean = raw.replace(/[^\p{L}\p{N}']/gu, '');
    const chars = Math.max(1, clean.length || raw.length || 1);

    let speech;
    if (lang === 'ar') {
        speech = Math.max(1, chars / 2.0);
    } else {
        const vowelGroups = clean.match(/[aeiouy]+/gi);
        const syllables = vowelGroups
            ? vowelGroups.length
            : Math.max(1, Math.ceil(chars / 3));
        // Heavier char contribution — closer to actual speech rate for neural TTS.
        speech = Math.max(0.85, syllables * 0.72 + chars * 0.12);
    }

    let pause = 0;
    if (/[.!?؟。…]$/.test(raw)) pause = 2.2;
    else if (/[,;:،؛]$/.test(raw)) pause = 0.95;
    else if (/[-–—]$/.test(raw)) pause = 0.5;
    else if (raw.endsWith('…')) pause = 1.8;

    return speech + pause;
}

/**
 * Map audio time → sentence index using the same weighted model as words.
 */
export function estimateSentenceIndex(sentences, currentTime, duration) {
    if (!sentences?.length || !duration) return 0;
    const weights = sentences.map((s) => Math.max(1, s.length));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const leadIn = Math.min(0.08, duration * 0.01);
    const trail = Math.min(0.18, duration * 0.02);
    const usable = Math.max(duration - leadIn - trail, duration * 0.94);
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
 * Optional lagMs shifts the clock slightly so the highlight leads the ear
 * (feels more natural for follow-along reading).
 */
export function wordIndexAtTime(wordStartTimes, currentTime, lagMs = 40) {
    if (!wordStartTimes?.length) return -1;
    const t = Math.max(0, currentTime + lagMs / 1000);
    let lo = 0;
    let hi = wordStartTimes.length - 1;
    let ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (wordStartTimes[mid] <= t) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}
