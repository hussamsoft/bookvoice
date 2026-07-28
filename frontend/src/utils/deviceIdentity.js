/**
 * Stable, opaque identity for this BookVoice browser profile.
 *
 * The backend mirrors this value into an HttpOnly cookie so media elements can
 * fetch device-owned assets without putting the identity in asset URLs. Keeping
 * the source value in localStorage also lets the browser restore its ownership
 * cookie if cookies alone are cleared.
 */
export const DEVICE_HEADER = 'X-BookVoice-Device-ID';
const STORAGE_KEY = 'bookvoice.device.id';
const DEVICE_ID_RE = /^[0-9a-f]{32}$/;
let memoryDeviceId = '';

function newDeviceId() {
    try {
        const uuid = crypto.randomUUID().replaceAll('-', '').toLowerCase();
        if (DEVICE_ID_RE.test(uuid)) return uuid;
    } catch {
        /* Fall through to browser-independent random bytes. */
    }
    try {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    } catch {
        return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    }
}

export function getDeviceId() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (DEVICE_ID_RE.test(stored || '')) {
            memoryDeviceId = stored;
            return stored;
        }
    } catch {
        /* A volatile id still keeps this visit internally consistent. */
    }
    if (!DEVICE_ID_RE.test(memoryDeviceId)) memoryDeviceId = newDeviceId();
    try {
        localStorage.setItem(STORAGE_KEY, memoryDeviceId);
    } catch {
        /* Private/blocked storage uses the in-memory id for this visit. */
    }
    return memoryDeviceId;
}

export function withDeviceIdentity(options = {}) {
    return {
        ...options,
        headers: {
            ...(options.headers || {}),
            [DEVICE_HEADER]: getDeviceId(),
        },
    };
}

export function resetDeviceIdentityForTests() {
    memoryDeviceId = '';
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        /* nothing to reset */
    }
}
