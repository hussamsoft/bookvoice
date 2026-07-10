import React, { useCallback, useEffect, useRef, useState } from 'react';
import { wordIndexAtTime, highlightLagMs } from '../utils/timings';
import Transcript from './Transcript';
import PlaybackControls from './PlaybackControls';
import { useAudioTransport } from '../hooks/useAudioTransport';
import { buildTimingsFromEntry } from '../utils/narrationPlayback';

/**
 * Audio playback with word-level follow-along (camera mode parity).
 */
export default function NarrationPlayback({
    audioUrl,
    text,
    languageId = 'en',
    onNextPage,
    segments = [],
    duration_s = 0,
    word_timings = [],
    downloadName = 'narration.wav',
}) {
    const audioRef = useRef(null);
    const [currentWord, setCurrentWord] = useState(-1);
    const [words, setWords] = useState([]);
    const wordTimesRef = useRef([]);
    const rafRef = useRef(0);
    const currentWordRef = useRef(-1);
    const transport = useAudioTransport(audioRef);

    useEffect(() => {
        buildTimingsFromEntry({
            text,
            segments,
            duration_s,
            word_timings,
            audioUrl,
            languageId,
        }).then(({ words: w, times }) => {
            setWords(w);
            wordTimesRef.current = times;
        });
    }, [audioUrl, text, segments, duration_s, word_timings, languageId]);

    const syncHighlight = useCallback(
        (t) => {
            const idx = wordIndexAtTime(
                wordTimesRef.current,
                t,
                highlightLagMs(languageId)
            );
            if (idx !== currentWordRef.current) {
                currentWordRef.current = idx;
                setCurrentWord(idx);
            }
        },
        [languageId]
    );

    const startLoop = useCallback(() => {
        const tick = () => {
            const audio = audioRef.current;
            if (!audio || audio.paused || audio.ended) {
                rafRef.current = 0;
                return;
            }
            syncHighlight(audio.currentTime);
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
    }, [syncHighlight]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;
        const onPlay = () => {
            startLoop();
        };
        const onPause = () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
        const onEnded = () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
        audio.addEventListener('play', onPlay);
        audio.addEventListener('pause', onPause);
        audio.addEventListener('ended', onEnded);
        return () => {
            audio.removeEventListener('play', onPlay);
            audio.removeEventListener('pause', onPause);
            audio.removeEventListener('ended', onEnded);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [startLoop]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || !audioUrl) return;
        audio.src = audioUrl;
        audio.play().catch(() => {});
    }, [audioUrl]);

    return (
        <div className="narration-playback">
            <Transcript
                words={words.length ? words : (text || '').split(/\s+/).filter(Boolean)}
                currentWord={currentWord}
                isPlaying={transport.isPlaying}
                isPaused={!transport.isPlaying && !!audioUrl}
                languageId={languageId}
            />
            <div className="playback-controls">
                <PlaybackControls transport={transport} />
                <a className="btn secondary" href={audioUrl} download={downloadName}>
                    Download audio
                </a>
                {onNextPage && (
                    <button className="btn secondary" onClick={onNextPage}>
                        Next page
                    </button>
                )}
            </div>
            <audio ref={audioRef} preload="auto" />
        </div>
    );
}
