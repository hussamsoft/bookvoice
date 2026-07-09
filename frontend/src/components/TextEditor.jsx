import React, { useEffect, useState } from 'react';
import { Play, RotateCcw, Languages, Loader2, Undo2 } from 'lucide-react';
import { translateText } from '../utils/api';
import { SUPPORTED_LANGUAGES } from '../utils/languages';
import { useToast } from './Toast';

export default function TextEditor({
    initialText,
    onNarrate,
    onRetake,
    onTranslateChange,
    targetLanguage,
}) {
    const toast = useToast();
    const [text, setText] = useState(initialText);
    const [originalText, setOriginalText] = useState(initialText);
    const [isNarrating, setIsNarrating] = useState(false);
    const [isTranslating, setIsTranslating] = useState(false);

    useEffect(() => {
        setText(initialText);
        setOriginalText(initialText);
    }, [initialText]);

    const handleTranslate = async () => {
        if (!text.trim()) return;
        setIsTranslating(true);
        try {
            // Keep current as original if we haven't stored a different base yet
            if (text === originalText || !originalText) {
                setOriginalText(text);
            }
            const translated = await translateText(text, targetLanguage);
            setText(translated);
            toast.success(
                targetLanguage === 'ar' ? 'Translated to Arabic' : 'Translated to English'
            );
        } catch (error) {
            toast.error(error.message);
        } finally {
            setIsTranslating(false);
        }
    };

    const handleRestore = () => {
        if (originalText != null) {
            setText(originalText);
            toast.info('Restored original text');
        }
    };

    const handleNarrate = async () => {
        if (!text.trim()) return;

        setIsNarrating(true);
        try {
            await onNarrate(text);
        } finally {
            setIsNarrating(false);
        }
    };

    const canRestore = originalText && originalText !== text;

    return (
        <div className="text-editor">
            <h3>Review extracted text</h3>

            <div className="translation-toolbar">
                <div className="lang-select-group">
                    <Languages size={16} />
                    <select
                        value={targetLanguage}
                        onChange={(e) => onTranslateChange(e.target.value)}
                        disabled={isTranslating || isNarrating}
                    >
                        {SUPPORTED_LANGUAGES.map((lang) => (
                            <option key={lang.code} value={lang.code}>
                                {lang.name}
                            </option>
                        ))}
                    </select>
                </div>
                <button
                    className="btn secondary"
                    onClick={handleTranslate}
                    disabled={isTranslating || isNarrating || !text.trim()}
                >
                    {isTranslating ? (
                        <>
                            <Loader2 className="spinner" size={16} /> Translating...
                        </>
                    ) : (
                        `Translate to ${targetLanguage === 'ar' ? 'Arabic' : 'English'}`
                    )}
                </button>
                {canRestore && (
                    <button
                        className="btn secondary"
                        onClick={handleRestore}
                        disabled={isTranslating || isNarrating}
                        title="Restore text before translation"
                    >
                        <Undo2 size={16} /> Restore
                    </button>
                )}
            </div>

            <p className="hint">
                Fix any OCR mistakes before narrating. Narration language:{' '}
                <strong>{targetLanguage === 'ar' ? 'Arabic' : 'English'}</strong>.
            </p>

            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={12}
                className="editor-textarea"
                disabled={isNarrating}
                dir={targetLanguage === 'ar' ? 'rtl' : 'ltr'}
            />

            <div className="editor-actions">
                {onRetake && (
                    <button onClick={onRetake} className="btn secondary" disabled={isNarrating}>
                        <RotateCcw size={16} /> Retake photo
                    </button>
                )}
                <button
                    onClick={handleNarrate}
                    className="btn primary"
                    disabled={isNarrating || !text.trim()}
                >
                    {isNarrating ? (
                        <>
                            <Loader2 className="spinner" size={16} /> Generating audio...
                        </>
                    ) : (
                        <>
                            <Play size={16} /> Narrate
                        </>
                    )}
                </button>
            </div>
        </div>
    );
}
