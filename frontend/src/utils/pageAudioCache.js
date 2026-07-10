/**
 * In-memory cache of narrated pages keyed by page + voice + language.
 * Enables instant page flips and near-instant re-select of a voice.
 */

export function cacheKey(page, voiceId, languageId) {
    return `${page}|${voiceId || 'default'}|${languageId || 'en'}`;
}

export function createPageAudioCache({ maxEntries = 12 } = {}) {
    /** @type {Map<string, object>} */
    const map = new Map();

    function touch(key) {
        const v = map.get(key);
        if (!v) return null;
        map.delete(key);
        map.set(key, v);
        return v;
    }

    function get(key) {
        return touch(key);
    }

    function set(key, entry) {
        if (map.has(key)) map.delete(key);
        map.set(key, { ...entry, updatedAt: Date.now() });
        while (map.size > maxEntries) {
            const oldest = map.keys().next().value;
            map.delete(oldest);
        }
        return map.get(key);
    }

    function hasReady(key) {
        const e = map.get(key);
        return !!(e && e.status === 'ready' && e.audioUrl);
    }

    /** Drop entries outside [lo, hi] page range (any voice/lang). */
    function retainPageWindow(lo, hi) {
        for (const key of [...map.keys()]) {
            const page = Number(String(key).split('|')[0]);
            if (!Number.isFinite(page) || page < lo || page > hi) {
                map.delete(key);
            }
        }
    }

    function clear() {
        map.clear();
    }

    function size() {
        return map.size;
    }

    return { get, set, hasReady, retainPageWindow, clear, size, cacheKey };
}
