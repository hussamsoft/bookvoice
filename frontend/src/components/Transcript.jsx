import React, { useState, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { narrateText } from '../utils/api';
import { createSessionId } from '../utils/session';
import { useToast } from './Toast';

export default function Transcript({
    words,
    wordStartTimes,
    currentWord,
    isPlaying,
    isPaused,
    sessionId,
    pageIndex,
    voiceId,
    languageId,
    onSeek,
}) {
    const toast = useToast();
    const [pronouncing, setPronouncing] = useState(null);
    const [hoveredWord, setHoveredWord] = useState(null);
    const pronounceRef = useRef(null);
    // Stable pronounce session (not recreated every render)
    const pronounceSessionRef = useRef(null);
    if (!pronounceSessionRef.current) {
        pronounceSessionRef.current = createSessionId('pronounce');
    }

    const handleWordClick = async (index, word) => {
        if (isPlaying || (isPaused && wordStartTimes[index] !== undefined)) {
            onSeek(wordStartTimes[index]);
            return;
        }
        if (!isPlaying && !isPaused) {
            setPronouncing(index);
            try {
                const cleanWord = word.replace(/[^\w\s'\u0600-\u06FF-]/g, '').trim();
                if (!cleanWord) return;
                const url = await narrateText(
                    cleanWord,
                    pronounceSessionRef.current,
                    0,
                    voiceId,
                    languageId
                );
                if (pronounceRef.current) {
                    pronounceRef.current.src = url;
                    await pronounceRef.current.play().catch(() => {});
                }
            } catch (error) {
                toast.error('Failed to pronounce: ' + error.message);
            } finally {
                setPronouncing(null);
            }
        }
    };

    if (!words || words.length === 0) {
        return (
            <div className="transcript-panel">
                <p className="transcript-empty">
                    Generate narration to see the transcript here.
                </p>
            </div>
        );
    }

    const dir = languageId === 'ar' ? 'rtl' : 'ltr';

    return (
        <div className="transcript-panel">
            <div className="transcript-header">
                <h3>Transcript</h3>
                <span className="transcript-word-count">{words.length} words</span>
            </div>
            <div className="transcript-words" dir={dir}>
                {words.map((word, i) => {
                    const isCurrent = i === currentWord;
                    const isHovered = i === hoveredWord;
                    const isPronouncing = i === pronouncing;
                    return (
                        <span
                            key={i}
                            className={`transcript-word ${isCurrent ? 'current' : ''} ${
                                isHovered ? 'hovered' : ''
                            }`}
                            onClick={() => handleWordClick(i, word)}
                            onMouseEnter={() => setHoveredWord(i)}
                            onMouseLeave={() => setHoveredWord(null)}
                        >
                            {word}
                            {isPronouncing && (
                                <Loader2 className="spin word-pronounce-spinner" size={10} />
                            )}
                        </span>
                    );
                })}
            </div>
            <audio ref={pronounceRef} style={{ display: 'none' }} />
        </div>
    );
}
