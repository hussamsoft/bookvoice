import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { formatClock as timeLabel } from '../utils/format';

/**
 * Audio playback that looks the same everywhere.
 *
 * Native `<audio controls>` is drawn by the browser, and Safari — iOS in
 * particular — renders it as an opaque dark slab that ignores the page theme.
 * This keeps a real `<audio>` element for playback and decoding but draws its
 * own transport, so the control matches the app on a phone as well as a desktop.
 *
 * The underlying element is exposed by ref, so callers that drive playback
 * themselves (seeking to a selected region, looping a range) keep working.
 */
const AudioPlayer = forwardRef(function AudioPlayer(
    { src, onTimeUpdate, onError, className = '', label = 'Audio', compact = false },
    ref
) {
    const audioRef = useRef(null);
    const [playing, setPlaying] = useState(false);
    const [current, setCurrent] = useState(0);
    const [duration, setDuration] = useState(0);

    useImperativeHandle(ref, () => audioRef.current, []);

    useEffect(() => {
        setPlaying(false);
        setCurrent(0);
        setDuration(0);
    }, [src]);

    const handleTimeUpdate = useCallback((event) => {
        setCurrent(event.target.currentTime || 0);
        onTimeUpdate?.(event);
    }, [onTimeUpdate]);

    const toggle = () => {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused) {
            audio.play().catch(() => setPlaying(false));
        } else {
            audio.pause();
        }
    };

    const seek = (event) => {
        const audio = audioRef.current;
        if (!audio || !Number.isFinite(duration) || duration <= 0) return;
        audio.currentTime = (Number(event.target.value) / 1000) * duration;
    };

    const progress = duration > 0 ? Math.min(1000, (current / duration) * 1000) : 0;

    return (
        <div className={`audio-transport ${compact ? 'is-compact' : ''} ${className}`.trim()}>
            <audio
                ref={audioRef}
                src={src}
                preload="metadata"
                aria-label={label || "Audio playback"}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={(event) => {
                    const value = event.target.duration;
                    setDuration(Number.isFinite(value) ? value : 0);
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onError={(event) => {
                    const audio = event.target;
                    const error = audio.error;
                    let message = 'Audio could not be played';
                    if (error) {
                        switch (error.code) {
                            case MediaError.MEDIA_ERR_DECODE:
                                message = 'Audio is corrupted or in an unsupported format';
                                break;
                            case MediaError.MEDIA_ERR_NETWORK:
                                message = 'Network error while loading audio';
                                break;
                            case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                                message = 'Audio format not supported';
                                break;
                            default:
                                message = `Audio error: ${error.message || 'unknown'}`;
                        }
                    }
                    setPlaying(false);
                    setDuration(0);
                    onError?.({ message, code: error?.code });
                }}
            />
            <button
                type="button"
                className="audio-transport-toggle"
                onClick={toggle}
                disabled={!src}
                aria-label={playing ? `Pause ${label}` : `Play ${label}`}
            >
                {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <input
                type="range"
                className="audio-transport-seek"
                min="0"
                max="1000"
                step="1"
                value={progress}
                onChange={seek}
                aria-label={`Seek ${label}`}
                aria-valuetext={`${timeLabel(current)} elapsed, ${timeLabel(Math.max(duration - current, 0))} remaining`}
            />
            <span className="audio-transport-time">
                {timeLabel(current)}<span aria-hidden="true"> / </span>{timeLabel(duration)}
            </span>
        </div>
    );
});

export default AudioPlayer;
