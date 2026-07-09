/** Stable, filesystem-safe session ids for the backend. */
export function createSessionId(prefix = 'session') {
    const safePrefix = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'session';
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return `${safePrefix}_${crypto.randomUUID().replace(/-/g, '')}`;
    }
    return `${safePrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
