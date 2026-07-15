/**
 * Resolve reader content from the persistent library before touching the PDF.
 * Prepared text is authoritative for its matching profile and avoids repeating
 * PDF extraction or OCR every time a warmed book is opened.
 */
export async function resolvePageContent({
    bookId,
    profileId,
    page,
    getPreparedPage,
    preparePageText,
}) {
    if (bookId && profileId) {
        try {
            const prepared = await getPreparedPage(bookId, profileId, page);
            const text = String(prepared?.text || '').trim();
            if (text) {
                return { text, prepared, source: 'prepared' };
            }
        } catch {
            // Library reads must degrade to the source PDF instead of blocking it.
        }
    }

    const text = await preparePageText(page);
    return { text, prepared: null, source: 'pdf' };
}

/**
 * Shape persisted prepared audio for the reader's ordinary transport path.
 * The library remains authoritative after a restart, when no in-memory page
 * cache is available yet.
 */
export function preparedPageAudioEntry({
    prepared,
    text,
    page,
    voiceId,
    languageId,
}) {
    if (!prepared?.audioUrl) return null;
    const timings = (Array.isArray(prepared.wordTimings) ? prepared.wordTimings : [])
        .filter((item) => String(item?.word || '').trim());
    const words = timings.map((item) => String(item.word).trim());
    const times = timings.map((item) => Number(item.start_s) || 0);
    const ends = timings.map((item) => Number(item.end_s) || 0);
    return {
        status: 'ready',
        page,
        voiceId: voiceId ?? null,
        languageId: languageId || 'en',
        text,
        audioUrl: prepared.audioUrl,
        segments: [],
        duration_s: Number(prepared.audio?.duration) || 0,
        words: words.length ? words : String(text || '').split(/\s+/).filter(Boolean),
        times,
        ends: times.length ? ends : [],
        timingMode: times.length ? 'aligned' : 'estimate',
        fromWord: 0,
        partial: false,
    };
}
