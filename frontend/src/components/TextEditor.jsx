import React, { useState } from 'react';
import { Play, RotateCcw } from 'lucide-react';

export default function TextEditor({ initialText, onNarrate, onRetake }) {
    const [text, setText] = useState(initialText);
    const [isNarrating, setIsNarrating] = useState(false);

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
