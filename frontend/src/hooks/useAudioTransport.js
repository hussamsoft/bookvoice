import { useCallback, useEffect, useState } from 'react';

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];

export function useAudioTransport(audioRef) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [mediaError, setMediaError] = useState('');

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return undefined;
        const updateTime = () => setCurrentTime(Number(audio.currentTime) || 0);
        const updateDuration = () => {
            const next = Number(audio.duration);
            setDuration(Number.isFinite(next) && next > 0 ? next : 0);
        };
        const onPlay = () => {
            setMediaError('');
            setIsPlaying(true);
        };
        const onPause = () => setIsPlaying(false);
        const onRate = () => setPlaybackRate(Number(audio.playbackRate) || 1);
        const onError = () => {
            setIsPlaying(false);
            setMediaError('Audio could not be loaded. Generate the page again.');
        };
        audio.addEventListener('timeupdate', updateTime);
        audio.addEventListener('loadedmetadata', updateDuration);
        audio.addEventListener('durationchange', updateDuration);
        audio.addEventListener('play', onPlay);
        audio.addEventListener('pause', onPause);
        audio.addEventListener('ended', onPause);
        audio.addEventListener('ratechange', onRate);
        audio.addEventListener('error', onError);
        updateTime();
        updateDuration();
        onRate();
        return () => {
            audio.removeEventListener('timeupdate', updateTime);
            audio.removeEventListener('loadedmetadata', updateDuration);
            audio.removeEventListener('durationchange', updateDuration);
            audio.removeEventListener('play', onPlay);
            audio.removeEventListener('pause', onPause);
            audio.removeEventListener('ended', onPause);
            audio.removeEventListener('ratechange', onRate);
            audio.removeEventListener('error', onError);
        };
    }, [audioRef]);

    const toggle = useCallback(async () => {
        const audio = audioRef.current;
        if (!audio) return false;
        if (!audio.paused && !audio.ended) {
            audio.pause();
            return false;
        }
        try {
            await audio.play();
            return true;
        } catch (error) {
            setMediaError(error?.message || 'Audio playback was blocked. Press Play again.');
            return false;
        }
    }, [audioRef]);

    const seekTo = useCallback(
        (seconds) => {
            const audio = audioRef.current;
            if (!audio) return;
            const max = Number.isFinite(audio.duration) && audio.duration > 0
                ? audio.duration
                : Math.max(0, Number(seconds) || 0);
            audio.currentTime = Math.max(0, Math.min(max, Number(seconds) || 0));
            setCurrentTime(audio.currentTime);
            audio.dispatchEvent(new Event('seeked'));
        },
        [audioRef]
    );

    const skipBy = useCallback(
        (seconds) => seekTo((Number(audioRef.current?.currentTime) || 0) + seconds),
        [audioRef, seekTo]
    );

    const cycleRate = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        const current = Number(audio.playbackRate) || 1;
        const index = PLAYBACK_RATES.indexOf(current);
        const next = PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
        audio.playbackRate = next;
        setPlaybackRate(next);
    }, [audioRef]);

    const setRate = useCallback(
        (rate) => {
            const audio = audioRef.current;
            const next = PLAYBACK_RATES.includes(Number(rate)) ? Number(rate) : 1;
            if (audio) audio.playbackRate = next;
            setPlaybackRate(next);
        },
        [audioRef]
    );

    return {
        currentTime,
        cycleRate,
        duration,
        isPlaying,
        mediaError,
        playbackRate,
        seekTo,
        setRate,
        skipBy,
        toggle,
    };
}
