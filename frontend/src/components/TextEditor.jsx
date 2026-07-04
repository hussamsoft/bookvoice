import React, { useState } from 'react';
import { Play, RotateCcw, Languages, Loader2 } from 'lucide-react';
import { translateText } from '../utils/api';

export default function TextEditor({ initialText, onNarrate, onRetake, onTranslateChange, targetLanguage }) {
    const [text, setText] = useState(initialText);
    const [isNarrating, setIsNarrating] = useState(false);
    const [isTranslating, setIsTranslating] = useState(false);

    const SUPPORTED_LANGUAGES = [
        { code: "en", name: "English" },
        { code: "ar", name: "Arabic" },
        { code: "da", name: "Danish" },
        { code: "de", name: "German" },
        { code: "el", name: "Greek" },
        { code: "es", name: "Spanish" },
        { code: "fi", name: "Finnish" },
        { code: "fr", name: "French" },
        { code: "he", name: "Hebrew" },
        { code: "hi", name: "Hindi" },
        { code: "it", name: "Italian" },
        { code: "ja", name: "Japanese" },
        { code: "ko", name: "Korean" },
        { code: "ms", name: "Malay" },
        { code: "nl", name: "Dutch" },
        { code: "no", name: "Norwegian" },
        { code: "pl", name: "Polish" },
        { code: "pt", name: "Portuguese" },
        { code: "ru", name: "Russian" },
        { code: "sv", name: "Swedish" },
        { code: "sw", name: "Swahili" },
        { code: "tr", name: "Turkish" },
        { code: "zh", name: "Chinese" }
    ];

    const handleTranslate = async () => {
        if (targetLanguage === "en" || !text.trim()) return;
        setIsTranslating(true);
        try {
            const translated = await translateText(text, targetLanguage);
            setText(translated);
        } catch (error) {
            alert(error.message);
        } finally {
            setIsTranslating(false);
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

    return (
        <div className="text-editor">
            <h3>Review Extracted Text</h3>
            
            <div className="translation-toolbar">
                <div className="lang-select-group">
                    <Languages size={16} />
                    <select 
                        value={targetLanguage} 
                        onChange={(e) => onTranslateChange(e.target.value)}
                        disabled={isTranslating || isNarrating}
                    >
                        {SUPPORTED_LANGUAGES.map(lang => (
                            <option key={lang.code} value={lang.code}>{lang.name}</option>
                        ))}
                    </select>
                </div>
                <button 
                    className="btn secondary" 
                    onClick={handleTranslate} 
                    disabled={targetLanguage === "en" || isTranslating || isNarrating}
                >
                    {isTranslating ? <><Loader2 className="spin" size={16} /> Translating...</> : 'Translate'}
                </button>
            </div>

            <p className="hint">Fix any OCR mistakes before narrating.</p>
            
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={12}
                className="editor-textarea"
                disabled={isNarrating}
            />
            
            <div className="editor-actions">
                <button 
                    onClick={onRetake} 
                    className="btn secondary"
                    disabled={isNarrating}
                >
                    <RotateCcw size={16} /> Retake Photo
                </button>
                <button 
                    onClick={handleNarrate} 
                    className="btn primary"
                    disabled={isNarrating || !text.trim()}
                >
                    <Play size={16} /> {isNarrating ? 'Generating Audio...' : 'Narrate'}
                </button>
            </div>
        </div>
    );
}
