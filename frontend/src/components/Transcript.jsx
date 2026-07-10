import React, { useState, useRef, useEffect } from 'react';
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
    voiceId,
    languageId,
    onSeek,
    statusHint,
}) {
    const toast = useToast();
    const [pronouncing, setPronouncing] = useState(null);
    const [hoveredWord, setHoveredWord] = useState(null);
    const pronounceRef = useRef(null);
    const wordsContainerRef = useRef(null);
    // Stable pronounce session (not recreated every render)
    const pronounceSessionRef = useRef(null);
    if (!pronounceSessionRef.current) {
        pronounceSessionRef.current = createSessionId('pronounce');
    }

    // Keep the active word in view without janky full-panel jumps.
    useEffect(() => {
        if (currentWord < 0 || !wordsContainerRef.current) return;
        const el = wordsContainerRef.current.querySelector(
            `[data-word-index="${currentWord}"]`
        );
        if (!el) return;
        try {
            el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        } catch {
            /* ignore */
        }
    }, [currentWord]);

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
                const { audioUrl } = await narrateText(
                    cleanWord,
                    pronounceSessionRef.current,
                    0,
                    voiceId,
                    languageId
                );
                if (pronounceRef.current) {
                    pronounceRef.current.src = audioUrl;
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
                <div className="transcript-header">
                    <h3>Follow along</h3>
                </div>
                <p className="transcript-empty">
                    {statusHint ||
                        'Press Read Page to generate narration. The spoken words appear here, synced with the PDF.'}
                </p>
            </div>
        );
    }

    const dir = languageId === 'ar' ? 'rtl' : 'ltr';

    return (
        <div className="transcript-panel">
            <div className="transcript-header">
                <h3>Follow along</h3>
                <span className="transcript-word-count">{words.length} words</span>
            </div>
            {statusHint ? <p className="transcript-status">{statusHint}</p> : null}
            <div className="transcript-words" dir={dir} ref={wordsContainerRef}>
                {words.map((word, i) => {
                    const isCurrent = i === currentWord;
                    const isPast = currentWord >= 0 && i < currentWord;
                    const isHovered = i === hoveredWord;
                    const isPronouncing = i === pronouncing;
                    return (
                        <span
                            key={i}
                            data-word-index={i}
                            className={`transcript-word ${isCurrent ? 'current' : ''} ${
                                isPast ? 'past' : ''
                            } ${isHovered ? 'hovered' : ''}`}
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
