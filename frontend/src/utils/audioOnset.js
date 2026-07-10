/**
 * Detect leading silence in a WAV/decoded audio buffer so word timings can
 * be shifted to the first real speech sample (Chatterbox often has 30–120ms
 * of near-silence that pure weight models miss).
 */

let sharedAudioContext = null;
const onsetCache = new Map();

function getSharedContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
        sharedAudioContext = new Ctx();
    }
    return sharedAudioContext;
}

/**
 * @param {string} audioUrl
 * @param {{ threshold?: number, maxScanSec?: number }} [opts]
 * @returns {Promise<number>} onset time in seconds
 */
export async function detectSpeechOnset(audioUrl, opts = {}) {
    if (onsetCache.has(audioUrl)) {
        return onsetCache.get(audioUrl);
    }

    const threshold = opts.threshold ?? 0.018;
    const maxScanSec = opts.maxScanSec ?? 0.6;

    try {
        const res = await fetch(audioUrl);
        if (!res.ok) return 0;
        const buf = await res.arrayBuffer();
        const ctx = getSharedContext();
        if (!ctx) return 0;
        const decoded = await ctx.decodeAudioData(buf.slice(0));
        const ch = decoded.getChannelData(0);
        const sr = decoded.sampleRate || 24000;
        const maxSamples = Math.min(ch.length, Math.floor(maxScanSec * sr));
        const win = Math.max(32, Math.floor(sr * 0.005));
        for (let i = 0; i + win < maxSamples; i += win) {
            let sum = 0;
            for (let j = 0; j < win; j++) {
                const s = ch[i + j];
                sum += s * s;
            }
            const rms = Math.sqrt(sum / win);
            if (rms >= threshold) {
                const onset = Math.max(0, i / sr - 0.01);
                onsetCache.set(audioUrl, onset);
                return onset;
            }
        }
        onsetCache.set(audioUrl, 0);
        return 0;
    } catch {
        return 0;
    }
}

/**
 * Shift all word start times so the first word lands at `onset`.
 * Preserves relative spacing; clamps to [0, duration).
 */
export function shiftTimingsToOnset(times, onset, duration = Infinity) {
    if (!times?.length) return times || [];
    const first = times[0] ?? 0;
    const delta = onset - first;
    if (Math.abs(delta) < 0.005) return times;
    return times.map((t) => {
        const v = t + delta;
        if (v < 0) return 0;
        if (Number.isFinite(duration) && v > duration) return Math.max(0, duration - 0.01);
        return v;
    });
}
