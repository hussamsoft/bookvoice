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

    return (
        <span
            data-word-index={index}
            className={`transcript-word${pronouncing ? ' pronouncing' : ''}`}
            onClick={activate}
            aria-busy={pronouncing || undefined}
            title="Hear this word or jump to it during narration"
        >
            {word}
        </span>
    );
});
