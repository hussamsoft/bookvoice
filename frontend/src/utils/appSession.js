/**
 * Small pieces of application state that belong to this browser/device.
 *
 * The server owns books and Voice Studio projects. It should not decide which
 * workspace a different machine opens into, so the selected top-level mode is
 * stored locally alongside the more detailed Voice Studio session.
 */
const STORAGE_KEY = 'bookvoice.app.mode';
const MODES = ['pdf', 'camera', 'studio'];

export function getAppMode() {
    try {
        const mode = localStorage.getItem(STORAGE_KEY);
        return MODES.includes(mode) ? mode : 'pdf';
    } catch {
        return 'pdf';
    }
}

export function setAppMode(mode) {
    if (!MODES.includes(mode)) return;
    try {
        localStorage.setItem(STORAGE_KEY, mode);
    } catch {
        /* The current visit still works when persistent storage is blocked. */
    }
}
