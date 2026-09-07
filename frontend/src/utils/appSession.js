/**
 * Small pieces of application state that belong to this browser/device.
 *
 * The server owns books and Voice Studio projects. It should not decide which
 * workspace a different machine opens into, so the selected view is stored
 * locally alongside the more detailed Voice Studio session.
 *
 * Views: home | library | reader | scan | studio | settings. `reader` is not
 * a nav destination — it is entered by opening a book from Home or Library
 * (or a `?book=` deep link) and always has a way back.
 */
const STORAGE_KEY = 'bookvoice.app.view';
const LEGACY_MODE_KEY = 'bookvoice.app.mode';
const LAST_BOOK_KEY = 'bookvoice.lastBook';
const VIEWS = ['home', 'library', 'reader', 'scan', 'studio', 'settings'];
const LEGACY_MODE_TO_VIEW = { pdf: 'home', camera: 'scan', studio: 'studio' };

export function getAppView() {
    try {
        const view = localStorage.getItem(STORAGE_KEY);
        if (VIEWS.includes(view) && view !== 'reader') return view;
        // Readers never persist: they are entered through a book, not a tab.
        const legacyMode = localStorage.getItem(LEGACY_MODE_KEY);
        if (LEGACY_MODE_TO_VIEW[legacyMode]) return LEGACY_MODE_TO_VIEW[legacyMode];
        return 'home';
    } catch {
        return 'home';
    }
}

export function setAppView(view) {
    if (!VIEWS.includes(view) || view === 'reader') return;
    try {
        localStorage.setItem(STORAGE_KEY, view);
    } catch {
        /* The current visit still works when persistent storage is blocked. */
    }
}

/** The book to offer first on Home. Cleared when the library book goes away. */
export function getLastBookId() {
    try {
        return localStorage.getItem(LAST_BOOK_KEY) || null;
    } catch {
        return null;
    }
}

export function setLastBookId(bookId) {
    try {
        if (bookId) localStorage.setItem(LAST_BOOK_KEY, String(bookId));
        else localStorage.removeItem(LAST_BOOK_KEY);
    } catch {
        /* Best-effort pointer only. */
    }
}
