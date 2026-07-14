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

// HTMLMediaElement.currentTime can lead the sound reaching the speakers by a
// small output-buffer interval. Delay the visual change so it follows the
// audible onset instead of anticipating it.
export const HIGHLIGHT_LAG_MS = { en: -20, ar: -25, default: -20 };

export function highlightLagMs(languageId = 'en') {
    const lang = (languageId || 'en').toLowerCase();
    return HIGHLIGHT_LAG_MS[lang] ?? HIGHLIGHT_LAG_MS.default;
}

/**
 * Build word start (and, when measured, end) times from backend
 * forced-alignment data. Returns { words, times, ends }; `ends[i]` is null
 * for words whose end had to be inferred rather than measured.
 */
export function timesFromWordTimings(wordTimings, pageText) {
    const words = String(pageText || '')
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length || !wordTimings?.length) {
        return { words, times: [], ends: [] };
    }
    const anchors = [];
    let ti = 0;
    for (let i = 0; i < words.length && ti < wordTimings.length; i++) {
        const wt = wordTimings[ti];
        const norm = (s) => String(s || '').replace(/[^\w\u0600-\u06FF']/g, '').toLowerCase();
        if (norm(wt.word) === norm(words[i])) {
            const start = Number(wt.start_s);
            if (Number.isFinite(start) && start >= 0) {
                const end = Number(wt.end_s);
                anchors.push({
                    index: i,
                    start,
                    end: Number.isFinite(end) && end > start ? end : null,
                });
            }
            ti++;
        }
    }
    if (anchors.length < words.length * 0.5) {
        return { words, times: [], ends: [] };
    }

    const times = new Array(words.length).fill(null);
    for (const anchor of anchors) times[anchor.index] = anchor.start;

    const first = anchors[0];
    if (first.index > 0) {
        const step = first.start / first.index;
        for (let i = 0; i < first.index; i++) times[i] = Math.max(0, step * i);
    }

    for (let a = 0; a < anchors.length - 1; a++) {
        const left = anchors[a];
        const right = anchors[a + 1];
        const slots = right.index - left.index;
        const step = slots > 0 ? (right.start - left.start) / slots : 0;
        for (let i = left.index + 1; i < right.index; i++) {
            times[i] = left.start + step * (i - left.index);
        }
    }

    const last = anchors[anchors.length - 1];
    if (last.index < words.length - 1) {
        const gaps = [];
        for (let i = 1; i < anchors.length; i++) {
            const indexGap = anchors[i].index - anchors[i - 1].index;
            const timeGap = anchors[i].start - anchors[i - 1].start;
            if (indexGap > 0 && timeGap > 0) gaps.push(timeGap / indexGap);
        }
        gaps.sort((a, b) => a - b);
        const step = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.2;
        for (let i = last.index + 1; i < words.length; i++) {
            times[i] = last.start + step * (i - last.index);
        }
    }

    if (times.some((t, i) => !Number.isFinite(t) || t < 0 || (i > 0 && t < times[i - 1]))) {
        return { words, times: [], ends: [] };
    }

    // Measured ends where the aligner reported them; inferred words fall back
    // to the next word's start so slicing never overlaps a neighbour.
    const ends = new Array(words.length).fill(null);
    for (const anchor of anchors) {
        if (anchor.end !== null) ends[anchor.index] = anchor.end;
    }
    for (let i = 0; i < ends.length; i++) {
        if (ends[i] === null || ends[i] <= times[i]) {
            const next = i + 1 < times.length ? times[i + 1] : times[i] + 0.35;
            ends[i] = Math.max(times[i] + 0.05, next);
        }
    }

    return { words, times, ends };
}

/**
 * Binary-search word index for a given audio time.
 * lagMs: negative delays the highlight to compensate for output latency.
 * Measured end times clear the highlight during real pauses.
 */
export function wordIndexAtTime(wordStartTimes, currentTime, lagMs = -55, wordEndTimes = []) {
    if (!wordStartTimes?.length) return -1;
    const t = currentTime + lagMs / 1000;
    // Skip leading sentinel slots (partial clips mark pre-resume words as -1).
    let lo = 0;
    while (lo < wordStartTimes.length && wordStartTimes[lo] < 0) lo++;
    if (lo >= wordStartTimes.length) return -1;

    let hi = wordStartTimes.length - 1;
    let ans = -1;
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
    if (ans < 0) return -1;
    const measuredEnd = Number(wordEndTimes?.[ans]);
    if (Number.isFinite(measuredEnd) && measuredEnd > wordStartTimes[ans] && t > measuredEnd) {
        const nextStart = Number(wordStartTimes[ans + 1]);
        if (!Number.isFinite(nextStart) || t < nextStart) return -1;
    }
    return ans;
}
