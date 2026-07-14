import React, { useState } from 'react';

export default React.memo(function TranscriptWord({ index, word, onActivate }) {
    const [pronouncing, setPronouncing] = useState(false);

    const activate = async () => {
        setPronouncing(true);
        try {
            await onActivate(index, word);
        } finally {
            setPronouncing(false);
        }
    };

    const handleKeyDown = (event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            activate();
        }
    };

    return (
        <span
            data-word-index={index}
            className={`transcript-word${pronouncing ? ' pronouncing' : ''}`}
            role="button"
            tabIndex={0}
            onClick={activate}
            onKeyDown={handleKeyDown}
            aria-busy={pronouncing || undefined}
            aria-label={`Word ${index + 1}: ${word}`}
            title="Hear this word or jump to it during narration"
        >
            {word}
        </span>
    );
});
