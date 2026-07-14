const LANGUAGE_LOCALES = {
    en: 'en-US',
    ar: 'ar-SA',
};

const NARRATOR_GENDER_MARKERS = {
    female: ['aria', 'natasha', 'sonia', 'open_female', 'female'],
    male: ['christopher', 'guy', 'ryan', 'open_male', 'male'],
};

const SYSTEM_GENDER_MARKERS = {
    female: ['aria', 'zira', 'jenny', 'susan', 'hazel', 'samantha', 'natasha', 'sonia', 'hoda', 'salma'],
    male: ['christopher', 'david', 'mark', 'guy', 'ryan', 'george', 'naayf'],
};

export function inferNarratorGender(voiceId) {
    const name = String(voiceId || '').toLowerCase();
    if (!name) return null;
    for (const [gender, markers] of Object.entries(NARRATOR_GENDER_MARKERS)) {
        if (markers.some((marker) => name.includes(marker))) return gender;
    }
    return null;
}

/** Keep the clicked word intact while dropping PDF/transcript punctuation. */
export function normalizePronunciationText(value) {
    return String(value || '')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[^\p{L}\p{M}\p{N}'-]+/gu, ' ')
        .trim();
}

function inferredSystemVoiceGender(voice) {
    const name = `${voice?.name || ''} ${voice?.voiceURI || ''}`.toLowerCase();
    for (const [gender, markers] of Object.entries(SYSTEM_GENDER_MARKERS)) {
        if (markers.some((marker) => name.includes(marker))) return gender;
    }
    return null;
}

function matchingVoice(voices, locale, preferredGender = null) {
    const normalizedLocale = locale.toLowerCase();
    const language = normalizedLocale.split('-')[0];
    const localVoices = voices.filter((voice) => voice?.localService !== false);
    const candidates = localVoices.length ? localVoices : voices;
    const languageCandidates = candidates.filter((voice) => {
        const voiceLanguage = voice?.lang?.toLowerCase() || '';
        return voiceLanguage === normalizedLocale || voiceLanguage.startsWith(`${language}-`) || voiceLanguage === language;
    });
    const genderMatch = preferredGender
        ? languageCandidates.find((voice) => inferredSystemVoiceGender(voice) === preferredGender)
        : null;
    return (
        genderMatch ||
        languageCandidates.find((voice) => voice?.lang?.toLowerCase() === normalizedLocale) ||
        languageCandidates[0] ||
        null
    );
}

/**
 * Speak a clicked word through the operating system voice service.
 *
 * This path starts immediately and is intentionally independent of the neural
 * narration queue. It returns false when the host does not expose local speech,
 * allowing callers to fall back to BookVoice TTS.
 */
export function pronounceWithSystemVoice(
    value,
    languageId = 'en',
    {
        speechSynthesis = globalThis.speechSynthesis,
        Utterance = globalThis.SpeechSynthesisUtterance,
        narratorVoiceId = null,
    } = {}
) {
    const text = normalizePronunciationText(value);
    if (!text || !speechSynthesis?.speak || !Utterance) return Promise.resolve(false);

    const locale = LANGUAGE_LOCALES[languageId] || languageId || 'en-US';
    const utterance = new Utterance(text);
    utterance.lang = locale;
    utterance.rate = 0.92;
    utterance.pitch = 1;
    utterance.volume = 1;

    try {
        const voices = speechSynthesis.getVoices?.() || [];
        const voice = matchingVoice(voices, locale, inferNarratorGender(narratorVoiceId));
        if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang || locale;
        }
        speechSynthesis.cancel();
    } catch {
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
            try {
                speechSynthesis.cancel();
            } finally {
                finish(false);
            }
        }, 4000);
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };
        utterance.onend = () => finish(true);
        utterance.onerror = (event) => {
            // A later word click intentionally cancels the previous utterance.
            // Treat that stale click as handled so it cannot fall through and
            // enqueue an obsolete neural clip behind the new pronunciation.
            const reason = String(event?.error || '').toLowerCase();
            finish(reason === 'interrupted' || reason === 'canceled');
        };
        try {
            speechSynthesis.speak(utterance);
        } catch {
            finish(false);
        }
    });
}

export function stopSystemPronunciation() {
    try {
        globalThis.speechSynthesis?.cancel?.();
    } catch {
        /* The host removed the speech bridge while the window was closing. */
    }
}
