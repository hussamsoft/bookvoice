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

function clearCursor(container) {
    if (!container) return;
    container.querySelector('.transcript-word.cursor')?.classList.remove('cursor');
}

function moveCursor(container, previousCursor, nextCursor) {
    if (!container || previousCursor === nextCursor) return;
    if (previousCursor >= 0) {
        container.querySelector(`[data-word-index="${previousCursor}"]`)?.classList.remove('cursor');
    }
    if (nextCursor >= 0) {
        container.querySelector(`[data-word-index="${nextCursor}"]`)?.classList.add('cursor');
    }
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
    const cursorIndexRef = useRef(-1);
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

    const handleWordsKeyDown = useCallback((event) => {
        const container = wordsContainerRef.current;
        const list = words || [];
        if (!container || list.length === 0) return;
        // With no cursor yet, movement starts from the narrated word (or the first).
        const base = cursorIndexRef.current >= 0
            ? cursorIndexRef.current
            : currentWordValueRef.current;
        let next;
        switch (event.key) {
            case 'ArrowRight':
                next = Math.min(list.length - 1, Math.max(0, base) + 1);
                break;
            case 'ArrowLeft':
                next = Math.max(0, Math.max(0, base) - 1);
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = list.length - 1;
                break;
            case 'Escape':
                clearCursor(container);
                cursorIndexRef.current = -1;
                return;
            case 'Enter':
            case ' ':
            case 'Spacebar':
                if (cursorIndexRef.current >= 0 && cursorIndexRef.current < list.length) {
                    event.preventDefault();
                    handleWordActivate(cursorIndexRef.current, list[cursorIndexRef.current]);
                } else if (currentWordValueRef.current >= 0 && currentWordValueRef.current < list.length) {
                    event.preventDefault();
                    handleWordActivate(currentWordValueRef.current, list[currentWordValueRef.current]);
                }
                return;
            default:
                return;
        }
        event.preventDefault();
        moveCursor(container, cursorIndexRef.current, next);
        cursorIndexRef.current = next;
    }, [handleWordActivate, words]);

    const handleWordsBlur = useCallback(() => {
        clearCursor(wordsContainerRef.current);
        cursorIndexRef.current = -1;
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
            element.classList.remove('current', 'past', 'cursor');
        });
        previousWordRef.current = -1;
        cursorIndexRef.current = -1;
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
                      ? 'Click a word to hear it instantly — resume starts there'
                      : 'Click a word to hear it instantly'}
            </p>
            <div
                className="transcript-words"
                dir={dir}
                lang={languageId || 'en'}
                ref={wordsContainerRef}
                tabIndex={0}
                role="region"
                aria-label="Narration transcript"
                onKeyDown={handleWordsKeyDown}
                onBlur={handleWordsBlur}
            >
                {wordElements}
            </div>
        </div>
    );
});
