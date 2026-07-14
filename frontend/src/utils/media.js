export function waitForAudioMetadata(audio, timeoutMs = 15000) {
    if (!audio) return Promise.reject(new Error('Audio player is unavailable.'));
    if (audio.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let timer = 0;
        const cleanup = () => {
            clearTimeout(timer);
            audio.removeEventListener('loadedmetadata', onMetadata);
            audio.removeEventListener('error', onError);
        };
        const onMetadata = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error('Audio could not be loaded. Generate the page again.'));
        };
        audio.addEventListener('loadedmetadata', onMetadata, { once: true });
        audio.addEventListener('error', onError, { once: true });
        timer = setTimeout(() => {
            cleanup();
            reject(new Error('Audio loading timed out. Generate the page again.'));
        }, timeoutMs);
    });
}

export function audioRangeForWord(wordStarts, index, duration, wordEnds = []) {
    const starts = Array.isArray(wordStarts) ? wordStarts : [];
    const safeIndex = Math.max(0, Math.min(Number(index) || 0, Math.max(0, starts.length - 1)));
    const start = Math.max(0, Number(starts[safeIndex]) || 0);
    const next = Number(starts[safeIndex + 1]);
    const total = Number(duration);
    const fallbackEnd = Number.isFinite(total) && total > start ? total : start + 0.6;
    let end = Number.isFinite(next) && next > start ? next : fallbackEnd;
    // A measured (forced-aligned) end beats the next word's onset: stop at the
    // word's own tail plus a small pad, but never overlap the next word.
    const aligned = Number(Array.isArray(wordEnds) ? wordEnds[safeIndex] : undefined);
    if (Number.isFinite(aligned) && aligned > start) {
        end = Math.min(aligned + 0.08, end);
    }
    return { start, end: Math.max(start + 0.12, end) };
}
