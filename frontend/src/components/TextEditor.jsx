import { useEffect, useRef, useState } from 'react';
import { Play, RotateCcw, Languages, Undo2 } from 'lucide-react';
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
    const baseTextRef = useRef(initialText);
    const [hasTranslated, setHasTranslated] = useState(false);
    const [isNarrating, setIsNarrating] = useState(false);
    const [isTranslating, setIsTranslating] = useState(false);

    useEffect(() => {
        setText(initialText);
        baseTextRef.current = initialText;
        setHasTranslated(false);
    }, [initialText]);

    const handleTranslate = async () => {
        if (!text.trim()) return;
        setIsTranslating(true);
        try {
            const result = await translateText(text, targetLanguage);
            baseTextRef.current = text;
            setText(result.translatedText);
            setHasTranslated(true);
        } catch (error) {
            toast.error(error.message);
        } finally {
            setIsTranslating(false);
        }
    };

    const handleRestore = () => {
        if (hasTranslated) {
            setText(baseTextRef.current);
            setHasTranslated(false);
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

    const canRestore = hasTranslated && baseTextRef.current !== text;

    return (
        <div className="text-editor">
            <h3 id="text-editor-heading">Review extracted text</h3>

            <div className="translation-toolbar">
                <div className="lang-select-group">
                    <Languages size={16} aria-hidden="true" />
                    <label className="sr-only" htmlFor="translation-lang">Translation language</label>
                    <select
                        id="translation-lang"
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
                            <span className="loading-waveform" aria-hidden="true">
                                <span /><span /><span /><span /><span />
                            </span>
                            Translating...
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

            <label className="sr-only" htmlFor="editor-textarea">Extracted text</label>
            <textarea
                id="editor-textarea"
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
                            <span className="loading-waveform" aria-hidden="true">
                                <span /><span /><span /><span /><span />
                            </span>
                            Narrating...
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
