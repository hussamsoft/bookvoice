/**
 * Estimate per-word start times for TTS playback highlighting.
 * Not forced-alignment, but much better than pure character ratios:
 * - syllable-ish weights
 * - punctuation pauses
 * - language-aware weighting for Arabic
 * - small lead-in / trail silence
 */
export function estimateWordTimings(words, duration, languageId = 'en') {
    if (!words?.length || !duration || duration <= 0) {
        return [];
    }

    const lang = (languageId || 'en').toLowerCase();
    const weights = words.map((word) => wordWeight(word, lang));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0) || 1;

    const leadIn = Math.min(0.25, duration * 0.02);
    const trail = Math.min(0.35, duration * 0.03);
    const usable = Math.max(duration - leadIn - trail, duration * 0.9);

    let t = leadIn;
    return weights.map((w) => {
        const start = t;
        t += (w / totalWeight) * usable;
        return start;
    });
}

function wordWeight(word, lang) {
    const raw = String(word || '');
    const clean = raw.replace(/[^\p{L}\p{N}']/gu, '');
    const chars = Math.max(1, clean.length || raw.length || 1);

    let speech;
    if (lang === 'ar') {
        // Arabic: roughly weight by characters with light syllable bias
        speech = Math.max(1, chars / 2.2);
    } else {
        const vowelGroups = clean.match(/[aeiouy]+/gi);
        const syllables = vowelGroups ? vowelGroups.length : Math.max(1, Math.ceil(chars / 3));
        speech = Math.max(1, syllables * 0.85 + chars * 0.08);
    }

    let pause = 0;
    if (/[.!?؟。…]$/.test(raw)) pause = 2.8;
    else if (/[,;:،؛]$/.test(raw)) pause = 1.15;
    else if (/[-–—]$/.test(raw)) pause = 0.6;
    else if (raw.endsWith('…')) pause = 2.2;

    return speech + pause;
}

/**
 * Map audio time → sentence index using the same weighted model as words.
 */
export function estimateSentenceIndex(sentences, currentTime, duration) {
    if (!sentences?.length || !duration) return 0;
    const weights = sentences.map((s) => Math.max(1, s.length));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const leadIn = Math.min(0.25, duration * 0.02);
    const trail = Math.min(0.35, duration * 0.03);
    const usable = Math.max(duration - leadIn - trail, duration * 0.9);
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
 */
export function wordIndexAtTime(wordStartTimes, currentTime) {
    if (!wordStartTimes?.length) return -1;
    let lo = 0;
    let hi = wordStartTimes.length - 1;
    let ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (wordStartTimes[mid] <= currentTime) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}
