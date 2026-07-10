const PREFIX = 'bookvoice:reader:';
const RATES = new Set([0.75, 1, 1.25, 1.5, 2]);

export function documentFingerprint(file) {
    if (!file) return '';
    return `${String(file.name || '')}\0${Number(file.size) || 0}\0${Number(file.lastModified) || 0}`;
}

function normalizeProgress(value = {}) {
    const page = Math.max(1, Math.floor(Number(value.page) || 1));
    const time = Math.max(0, Number(value.time) || 0);
    const zoom = Math.max(0.7, Math.min(2.6, Number(value.zoom) || 1));
    const rate = Number(value.playbackRate) || 1;
    const bookmarks = [...new Set((Array.isArray(value.bookmarks) ? value.bookmarks : [])
        .map((item) => Math.floor(Number(item)))
        .filter((item) => item > 0))].sort((a, b) => a - b);
    return {
        page,
        time,
        zoom,
        playbackRate: RATES.has(rate) ? rate : 1,
        bookmarks,
    };
}

export function loadReadingProgress(documentId) {
    if (!documentId) return normalizeProgress();
    try {
        const raw = localStorage.getItem(PREFIX + documentId);
        return normalizeProgress(raw ? JSON.parse(raw) : {});
    } catch {
        return normalizeProgress();
    }
}

export function saveReadingProgress(documentId, progress) {
    const normalized = normalizeProgress(progress);
    if (!documentId) return normalized;
    try {
        localStorage.setItem(PREFIX + documentId, JSON.stringify(normalized));
    } catch {
        // Reading still works when storage is blocked or full.
    }
    return normalized;
}

export function toggleBookmark(bookmarks, page) {
    const target = Math.max(1, Math.floor(Number(page) || 1));
    const next = new Set(Array.isArray(bookmarks) ? bookmarks : []);
    if (next.has(target)) next.delete(target);
    else next.add(target);
    return [...next].sort((a, b) => a - b);
}
