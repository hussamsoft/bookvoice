import React from 'react';
import Transcript from '../Transcript';

/**
 * Left-hand page column for text books (.epub/.txt/.md): presents the
 * current server page with the same word-span transcript presentation used
 * for PDF narration, so click-to-pronounce and follow-highlight behave
 * identically in both modes.
 */
export default function TextPageColumn({
    pageWords,
    currentWord,
    audioPage,
    pageNumber,
    isPlaying,
    audioUrl,
    targetLanguage,
    onWordActivate,
    statusHint,
    followNarration,
}) {
    return (
        <Transcript
            words={pageWords}
            currentWord={audioPage === pageNumber ? currentWord : -1}
            isPlaying={audioPage === pageNumber && isPlaying}
            isPaused={!!audioUrl && audioPage === pageNumber && !isPlaying}
            languageId={targetLanguage}
            onWordActivate={onWordActivate}
            statusHint={statusHint}
            followNarration={followNarration}
        />
    );
}
