/** App only supports English and Arabic end-to-end. */
export const SUPPORTED_LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'ar', name: 'Arabic' },
];

export function isSupportedLanguage(code) {
    return SUPPORTED_LANGUAGES.some((l) => l.code === code);
}

export function languageName(code) {
    return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.name || code;
}
