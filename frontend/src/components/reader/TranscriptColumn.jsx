import React from 'react';
import Transcript from '../Transcript';

/**
 * The right-hand transcript column: text actions, inline editing, or the
 * follow-along word view.
 */
export default function TranscriptColumn({
    pageText,
    isEditingText,
    onToggleEditText,
    onTranslatePage,
    targetLanguage,
    isGenerating,
    editTextDraft,
    onEditTextDraft,
    onSaveEditedText,
    pageWords,
    currentWord,
    audioPage,
    pageNumber,
    isPlaying,
    audioUrl,
    onWordActivate,
    statusHint,
    followNarration,
}) {
    return (
        <>
            <div className="pdf-transcript-actions">
                <button
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={onToggleEditText}
                    disabled={!pageText}
                >
                    {isEditingText ? 'Cancel editing' : 'Edit text'}
                </button>
                <button
                    type="button"
                    className="btn secondary btn-compact"
                    onClick={onTranslatePage}
                    disabled={!pageText || isGenerating}
                >
                    Translate to {targetLanguage === 'ar' ? 'English' : 'Arabic'}
                </button>
            </div>
            {isEditingText ? (
                <div className="pdf-text-edit-wrap">
                    <label className="sr-only" htmlFor="page-text-edit">
                        Page text
                    </label>
                    <textarea
                        id="page-text-edit"
                        className="pdf-text-edit"
                        value={editTextDraft}
                        onChange={(event) => onEditTextDraft(event.target.value)}
                    />
                    <div className="editor-actions">
                        <button type="button" className="btn primary btn-compact" onClick={onSaveEditedText}>
                            Save text
                        </button>
                    </div>
                </div>
            ) : (
                <Transcript
                    words={pageWords}
                    currentWord={audioPage === pageNumber ? currentWord : -1}
                    isPlaying={audioPage === pageNumber && isPlaying}
                    isPaused={!!audioUrl && audioPage === pageNumber && !isPlaying && !isGenerating}
                    languageId={targetLanguage}
                    onWordActivate={onWordActivate}
                    statusHint={statusHint || (isGenerating ? 'Generating narration…' : undefined)}
                    followNarration={followNarration}
                />
            )}
        </>
    );
}
