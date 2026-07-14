import { useCallback, useEffect, useState } from 'react';

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];

export function useAudioTransport(audioRef, timelineRef = null) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [mediaError, setMediaError] = useState('');

    const readCurrentTime = useCallback((audio) => {
        const mapped = timelineRef?.current?.getCurrentTime?.(audio);
        return Number.isFinite(mapped) ? Math.max(0, mapped) : (Number(audio?.currentTime) || 0);
    }, [timelineRef]);

    const readDuration = useCallback((audio) => {
        const mapped = timelineRef?.current?.getDuration?.(audio);
        if (Number.isFinite(mapped)) return Math.max(0, mapped);
        const nativeDuration = Number(audio?.duration);
        return Number.isFinite(nativeDuration) && nativeDuration > 0 ? nativeDuration : 0;
    }, [timelineRef]);

    const refresh = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        setCurrentTime(readCurrentTime(audio));
        setDuration(readDuration(audio));
        setPlaybackRate(Number(audio.playbackRate) || 1);
    }, [audioRef, readCurrentTime, readDuration]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return undefined;
        const updateTime = () => setCurrentTime(readCurrentTime(audio));
        const updateDuration = () => setDuration(readDuration(audio));
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
    }, [audioRef, readCurrentTime, readDuration]);

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
            const requested = Math.max(0, Number(seconds) || 0);
            const max = readDuration(audio) || requested;
            const target = Math.max(0, Math.min(max, requested));
            const mappedSeek = timelineRef?.current?.seekTo;
            let displayed = target;
            if (mappedSeek) {
                const result = mappedSeek(target, audio);
                if (Number.isFinite(result)) displayed = result;
            } else {
                audio.currentTime = target;
                displayed = audio.currentTime;
            }
            setCurrentTime(displayed);
            setDuration(readDuration(audio));
            audio.dispatchEvent(new Event('seeked'));
            return displayed;
        },
        [audioRef, readDuration, timelineRef]
    );

    const skipBy = useCallback(
        (seconds) => {
            const audio = audioRef.current;
            if (!audio) return;
            return seekTo(readCurrentTime(audio) + seconds);
        },
        [audioRef, readCurrentTime, seekTo]
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
        refresh,
        seekTo,
        setRate,
        skipBy,
        toggle,
    };
}
