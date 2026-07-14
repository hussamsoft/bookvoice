import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import TranscriptWord from './TranscriptWord';

function updatePlaybackClasses(container, previousWord, currentWord) {
    if (!container || previousWord === currentWord) return;
    if (previousWord >= 0) {
        container.querySelector(`[data-word-index="${previousWord}"]`)?.classList.remove('current');
    }
    if (currentWord < 0) {
        container.querySelectorAll('.transcript-word').forEach((element) => {
            element.classList.remove('current', 'past');
        });
        return;
    }
    if (previousWord < currentWord) {
        for (let index = Math.max(0, previousWord); index < currentWord; index += 1) {
            container.querySelector(`[data-word-index="${index}"]`)?.classList.add('past');
        }
    } else {
        for (let index = currentWord; index < previousWord; index += 1) {
            container.querySelector(`[data-word-index="${index}"]`)?.classList.remove('past');
        }
    }
    const current = container.querySelector(`[data-word-index="${currentWord}"]`);
    current?.classList.remove('past');
    current?.classList.add('current');
}

/**
 * Follow-along transcript.
 *
 * Click behavior is owned by the parent via onWordActivate so pause/play
 * semantics stay consistent with the main audio element:
 *  - playing  → seek + keep playing
 *  - paused   → pronounce word + set resume point (do not auto-resume)
 *  - idle     → pronounce only
 */
export default React.memo(function Transcript({
    words,
    currentWord,
    isPlaying,
    isPaused,
    onWordActivate,
    statusHint,
    languageId,
    followNarration = false,
}) {
    const wordsContainerRef = useRef(null);
    const previousWordRef = useRef(-1);
    const currentWordValueRef = useRef(currentWord);
    const interactionRef = useRef({ onWordActivate, isPlaying, isPaused });
    currentWordValueRef.current = currentWord;
    interactionRef.current = { onWordActivate, isPlaying, isPaused };

    const handleWordActivate = useCallback(async (index, word) => {
        const interaction = interactionRef.current;
        await interaction.onWordActivate?.(index, word, {
            isPlaying: interaction.isPlaying,
            isPaused: interaction.isPaused,
        });
    }, []);

    const wordElements = useMemo(
        () =>
            (words || []).map((word, index) => (
                <React.Fragment key={index}>
                    <TranscriptWord
                        index={index}
                        word={word}
                        onActivate={handleWordActivate}
                    />
                    {index < words.length - 1 ? ' ' : null}
                </React.Fragment>
            )),
        [handleWordActivate, words]
    );

    useLayoutEffect(() => {
        const container = wordsContainerRef.current;
        if (!container) return;
        container.querySelectorAll('.transcript-word').forEach((element) => {
            element.classList.remove('current', 'past');
        });
        previousWordRef.current = -1;
        updatePlaybackClasses(container, -1, currentWordValueRef.current);
        previousWordRef.current = currentWordValueRef.current;
    }, [words]);

    useLayoutEffect(() => {
        const container = wordsContainerRef.current;
        if (!container) return;
        updatePlaybackClasses(container, previousWordRef.current, currentWord);
        previousWordRef.current = currentWord;
    }, [currentWord, words]);

    useEffect(() => {
        const container = wordsContainerRef.current;
        if (!followNarration || currentWord < 0 || !container) return;
        const el = container.querySelector(
            `[data-word-index="${currentWord}"]`
        );
        if (!el) return;
        const target = Math.max(0, el.offsetTop - (container.clientHeight - el.offsetHeight) / 2);
        container.scrollTop = target;
    }, [currentWord, followNarration]);

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
            <div className="transcript-words" dir={dir} lang={languageId || 'en'} ref={wordsContainerRef}>
                {wordElements}
            </div>
        </div>
    );
});
