/**
 * Safe wrappers around the Media Session API so OS media keys and media
 * overlays can drive narration. Every function is a no-op when the API is
 * unavailable (unsupported browsers and jsdom test environments).
 */

const KNOWN_ACTIONS = [
    'play',
    'pause',
    'stop',
    'previoustrack',
    'nexttrack',
    'seekbackward',
    'seekforward',
    'seekto',
];

function getSession() {
    return typeof navigator !== 'undefined' && navigator.mediaSession
        ? navigator.mediaSession
        : null;
}

export function updateMediaSession({ title = '', artist = '', album = '', artwork } = {}) {
    const session = getSession();
    if (!session) return;
    try {
        if (typeof MediaMetadata === 'undefined') return;
        session.metadata = new MediaMetadata({
            title,
            artist,
            album,
            artwork: artwork ? [{ src: artwork }] : [],
        });
    } catch {
        /* metadata updates must never break playback */
    }
}

export function setPlaybackState(playing) {
    const session = getSession();
    if (!session) return;
    try {
        session.playbackState = playing ? 'playing' : 'paused';
    } catch {
        /* ignore */
    }
}

export function setPositionState({ duration, position, rate } = {}) {
    const session = getSession();
    if (!session || typeof session.setPositionState !== 'function') return;
    const safeDuration = Number(duration);
    if (!(safeDuration > 0)) return;
    try {
        session.setPositionState({
            duration: safeDuration,
            position: Math.min(Math.max(Number(position) || 0, 0), safeDuration),
            playbackRate: Number(rate) > 0 ? Number(rate) : 1,
        });
    } catch {
        /* invalid states throw in some engines; playback continues */
    }
}

/** Register OS action handlers; pass null to release every handler. */
export function setActionHandlers(map) {
    const session = getSession();
    if (!session || typeof session.setActionHandler !== 'function') return;
    for (const action of KNOWN_ACTIONS) {
        const handler = map ? map[action] : null;
        try {
            session.setActionHandler(action, typeof handler === 'function' ? handler : null);
        } catch {
            /* unsupported action on this platform */
        }
    }
}

/** Drop metadata and every action handler (book close / reader unmount). */
export function clearMediaSession() {
    const session = getSession();
    if (!session) return;
    setActionHandlers(null);
    try {
        session.metadata = null;
        session.playbackState = 'none';
    } catch {
        /* ignore */
    }
}
