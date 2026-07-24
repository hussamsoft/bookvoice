export function missingPreparedTextPages(pageCount, pageHashes = {}) {
    const total = Math.max(0, Number(pageCount) || 0);
    const persisted = new Set();
    for (const name of Object.keys(pageHashes || {})) {
        const match = /^([1-9]\d*)\.json$/.exec(name);
        if (!match) continue;
        const page = Number(match[1]);
        if (page <= total) persisted.add(page);
    }
    const missing = [];
    for (let page = 1; page <= total; page += 1) {
        if (!persisted.has(page)) missing.push(page);
    }
    return missing;
}

function profileList(book) {
    const profiles = book?.profiles;
    if (Array.isArray(profiles)) return profiles;
    if (profiles && typeof profiles === 'object') return Object.values(profiles);
    return [];
}

export function activePreparedProfile(book) {
    const profiles = profileList(book);
    const activeId = book?.activeProfileId;
    return profiles.find((profile) => profile?.id === activeId) || profiles[0] || null;
}

export function preparationForActiveProfile(book) {
    const profile = activePreparedProfile(book);
    const preparation = book?.preparation || null;
    if (!profile) return preparation;
    if (
        preparation?.profileId === profile.id &&
        preparation.status !== 'COMPLETED'
    ) return preparation;

    const totalPages = Math.max(0, Number(book?.pageCount) || 0);
    const completedPages = [...new Set(
        (Array.isArray(profile.readyPages) ? profile.readyPages : [])
            .map(Number)
            .filter((page) => Number.isInteger(page) && page > 0 && page <= totalPages)
    )].sort((a, b) => a - b);
    return {
        id: null,
        bookId: book?.id || null,
        profileId: profile.id,
        voiceId: profile.voiceId ?? null,
        languageId: profile.languageId || 'en',
        status:
            totalPages > 0 && completedPages.length >= totalPages
                ? 'COMPLETED'
                : 'PAUSED',
        completedPages,
        totalPages,
        currentPage: null,
        error: null,
    };
}

/**
 * Decide whether the reader should adopt a preparation's profile for playback.
 *
 * A preparation writes its audio under its own profile id, so the reader can
 * only play those pages back while reading from the same profile. We adopt as
 * soon as the job exists rather than waiting for COMPLETED, so pages the job
 * has already finished play from disk instead of being regenerated on demand.
 * Any status is adoptable — a page that is prepared stays prepared even if the
 * job later paused or failed, and unprepared pages fall back to on-demand
 * narration anyway.
 *
 * The voice and language must match what the reader is currently using, so one
 * voice's audio is never served while another is selected.
 */
export function shouldAdoptPreparedProfile({ preparation, voiceId, languageId } = {}) {
    if (!preparation?.profileId) return false;
    if ((preparation.voiceId ?? null) !== (voiceId ?? null)) return false;
    return (preparation.languageId || 'en') === (languageId || 'en');
}

export function preparedBookDetails(book) {
    const profile = activePreparedProfile(book);
    const pageCount = Math.max(0, Number(book?.pageCount) || 0);
    const resumePage = Math.max(1, Math.min(pageCount || 1, Number(book?.progress?.page) || 1));
    const bookmarks = [...new Set((book?.progress?.bookmarks || [])
        .map(Number)
        .filter((page) => Number.isInteger(page) && page > 0 && (!pageCount || page <= pageCount))
    )].sort((a, b) => a - b);
    const preparedPages = new Set((profile?.readyPages || []).map(Number).filter(Number.isInteger)).size;
    return { pageCount, resumePage, bookmarks, preparedPages };
}
