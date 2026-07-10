import React, { useState, useRef, useEffect } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Follow-along transcript.
 *
 * Click behavior is owned by the parent via onWordActivate so pause/play
 * semantics stay consistent with the main audio element:
 *  - playing  → seek + keep playing
 *  - paused   → pronounce word + set resume point (do not auto-resume)
 *  - idle     → pronounce only
 */
export default function Transcript({
    words,
    currentWord,
    isPlaying,
    isPaused,
    onWordActivate,
    statusHint,
    languageId,
}) {
    const [hoveredWord, setHoveredWord] = useState(null);
    const [pronouncing, setPronouncing] = useState(null);
    const wordsContainerRef = useRef(null);

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
        setPronouncing(index);
        try {
            await onWordActivate?.(index, word, {
                isPlaying,
                isPaused,
            });
        } finally {
            setPronouncing(null);
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
                        'Press Read to generate narration. Words here stay linked to the spoken voice — click any word to hear it.'}
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
            <p className="transcript-hint">
                {isPlaying
                    ? 'Click a word to jump there'
                    : isPaused
                      ? 'Click a word to hear it — resume starts there'
                      : 'Click a word to hear pronunciation'}
            </p>
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
                            } ${isHovered ? 'hovered' : ''} ${
                                isPronouncing ? 'pronouncing' : ''
                            }`}
                            onClick={() => handleWordClick(i, word)}
                            onMouseEnter={() => setHoveredWord(i)}
                            onMouseLeave={() => setHoveredWord(null)}
                            title={
                                isPlaying
                                    ? 'Jump to this word'
                                    : 'Hear this word (sets resume point)'
                            }
                        >
                            {word}
                            {isPronouncing && (
                                <Loader2 className="spin word-pronounce-spinner" size={10} />
                            )}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}
