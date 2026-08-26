import { getAccess, getUserConfig } from './api';

/**
 * Runtime capability flags reported by the backend.
 *
 * The desktop app can save into the Windows Downloads folder and open a
 * project folder in Explorer; a hosted deployment can do neither, and asks for
 * a password instead. The UI reads these once and hides what is unavailable
 * rather than offering actions that would fail or write somewhere unreachable.
 */
export const DEFAULT_CAPABILITIES = {
    serverMode: false,
    localFileActions: true,
    authRequired: false,
};

let cached = null;

export function loadCapabilities() {
    if (!cached) {
        cached = getUserConfig()
            .then((data) => ({ ...DEFAULT_CAPABILITIES, ...(data?.capabilities || {}) }))
            .catch(() => ({ ...DEFAULT_CAPABILITIES }));
    }
    return cached;
}


export function resetCapabilities() {
    cached = null;
}

export async function loadAccessState() {
    try {
        return await getAccess();
    } catch {
        return { authRequired: false, authenticated: true };
    }
}
