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
