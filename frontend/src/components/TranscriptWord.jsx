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

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
        }
    };

    return (
        <span
            data-word-index={index}
            className={`transcript-word${pronouncing ? ' pronouncing' : ''}`}
            onClick={activate}
            onKeyDown={handleKeyDown}
            role="button"
            aria-busy={pronouncing || undefined}
            aria-label={word}
            title="Hear this word or jump to it during narration"
        >
            {word}
        </span>
    );
});

