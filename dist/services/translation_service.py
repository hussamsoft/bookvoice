from deep_translator import GoogleTranslator

def translate_text(text: str, target_lang: str) -> str:
    """
    Translates text to the target language using deep-translator.
    We use GoogleTranslator as a free MVP backend.
    """
    if not text.strip():
        return ""
    
    # deep-translator expects language codes like 'fr', 'es', 'de'
    # which conveniently match Chatterbox's language codes.
    try:
        translator = GoogleTranslator(source='auto', target=target_lang)
        # deep-translator limits single translation to 5000 chars, chunk if necessary.
        # But for book pages, it should be well under 5000 chars.
        translated = translator.translate(text)
        return translated
    except Exception as e:
        raise Exception(f"Translation failed: {str(e)}")
