/**
 * Namespaced localStorage helpers. Every persisted preference goes through
 * here with a single `bookvoice.` dot convention, and legacy colon-style
 * keys are still read so existing users keep their settings.
 */

function readRaw(key, legacyKeys = []) {
    try {
        const current = window.localStorage.getItem(key);
        if (current !== null) return current;
        for (const legacy of legacyKeys) {
            const value = window.localStorage.getItem(legacy);
            if (value !== null) return value;
        }
    } catch {
        /* Storage may be unavailable; callers fall back to defaults. */
    }
    return null;
}

export function readStoredString(key, { legacyKeys = [], fallback = '' } = {}) {
    return readRaw(key, legacyKeys) ?? fallback;
}

export function writeStoredString(key, value) {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        /* Ignore write failures; the app stays functional without persistence. */
    }
}
