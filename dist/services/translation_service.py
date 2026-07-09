from deep_translator import GoogleTranslator

from services.path_utils import SUPPORTED_LANGUAGES, validate_language_id

# deep-translator free Google backend is limited to ~5000 chars per call.
_CHUNK_SIZE = 4500


def _chunk_text(text: str, size: int = _CHUNK_SIZE) -> list[str]:
    if len(text) <= size:
        return [text]

    chunks: list[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= size:
            chunks.append(remaining)
            break
        # Prefer splitting on paragraph / sentence / space near the limit.
        window = remaining[:size]
        split_at = max(window.rfind("\n\n"), window.rfind("\n"), window.rfind(". "), window.rfind(" "))
        if split_at < size // 3:
            split_at = size
        chunks.append(remaining[:split_at].strip())
        remaining = remaining[split_at:].lstrip()
    return [c for c in chunks if c]


def translate_text(text: str, target_lang: str) -> str:
    """
    Translate text to English or Arabic using deep-translator (Google free endpoint).
    """
    if not text or not text.strip():
        return ""

    target_lang = validate_language_id(target_lang)
    if target_lang not in SUPPORTED_LANGUAGES:
        raise ValueError("Only English (en) and Arabic (ar) are supported.")

    try:
        translator = GoogleTranslator(source="auto", target=target_lang)
        parts = []
        for chunk in _chunk_text(text.strip()):
            translated = translator.translate(chunk)
            if translated:
                parts.append(translated)
        return "\n\n".join(parts).strip()
    except Exception as e:
        raise RuntimeError(f"Translation failed: {e}") from e
