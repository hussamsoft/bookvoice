import React, { useImperativeHandle } from 'react';
import { ChevronDown, RotateCcw, RotateCw, Square } from 'lucide-react';
import { formatClock as formatTime } from '../utils/format';
import { SLEEP_END_OF_CHAPTER, SLEEP_MINUTE_OPTIONS, useSleepTimer } from '../hooks/useSleepTimer';

/**
 * Focused narration transport.
 *  - Primary row (≤4 visible elements): Play/Pause (44px, Signal hue when
 *    playing) + scrubber + time.
 *  - Secondary row (muted, --ink-muted): rate, sleep, page-label.
 */
export default function PlaybackControls({
    transport,
    onToggle = transport.toggle,
    compact = false,
    generating = false,
    disabled = false,
    hasMedia = false,
    duration = null,
    onSeek,
    onStop,
    sleepRef,
    pageLabel = '',
}) {
    // Sleep timer counts down only while narration plays; expiry reuses the
    // Stop button's path when the consumer provides one, otherwise pause.
    const sleep = useSleepTimer({
        playing: !!transport.isPlaying,
        onExpire: onStop || (() => transport.toggle()),
    });

    // Consumers that know when a page finishes naturally (the reader) signal
    // the "end of chapter" sleep mode through this handle.
    useImperativeHandle(sleepRef, () => ({ notifyPageEnded: sleep.notifyPageEnded }), [
        sleep.notifyPageEnded,
    ]);

    const handleSleepChange = (event) => {
        const value = event.target.value;
        if (value === 'off') {
            sleep.cancel();
        } else if (value === SLEEP_END_OF_CHAPTER) {
            sleep.setMinutes(SLEEP_END_OF_CHAPTER);
        } else {
            sleep.setMinutes(Number(value));
        }
    };
    const canSeek = transport.duration > 0;
    const playDisabled = disabled && !transport.isPlaying;
    // Scrubber appears only when the consumer provides both a playlist-global
    // duration and a seek callback (see PdfViewer wiring).
    const showScrubber = Number.isFinite(duration) && duration > 0 && typeof onSeek === 'function';
    const elapsed = Math.min(Math.max(Number(transport.currentTime) || 0, 0), duration);
    const handleSeek = (event) => {
        const seconds = Number(event.target.value);
        onSeek(Math.min(Math.max(seconds, 0), duration));
    };
    const canStop = generating || hasMedia || transport.isPlaying;
    return (
        <div className={`playback-transport ${compact ? 'compact' : ''}`}>
            {/* Secondary row (muted): rate, sleep, page-label */}
            <div className="transport-secondary">
                <button
                    type="button"
                    className="btn secondary compact transport-stop"
                    onClick={onStop}
                    disabled={!canStop || !onStop}
                    aria-label="Stop narration"
                    title="Stop and return to the beginning"
                >
                    <Square size={14} fill="currentColor" />
                    {!compact && 'Stop'}
                </button>
                <button
                    type="button"
                    className="btn secondary compact transport-skip"
                    onClick={() => transport.skipBy(-10)}
                    disabled={!canSeek}
                    aria-label="Skip back 10 seconds"
                    title="Back 10 seconds"
                >
                    <RotateCcw size={15} />
                    <span className="transport-label">Back 10</span>
                </button>
                <button
                    type="button"
                    className="btn secondary compact transport-skip"
                    onClick={() => transport.skipBy(10)}
                    disabled={!canSeek}
                    aria-label="Skip forward 10 seconds"
                    title="Forward 10 seconds"
                >
                    <RotateCw size={15} />
                    <span className="transport-label">Forward 10</span>
                </button>
                <label className="transport-rate-control">
                    <span className="sr-only">Narration speed</span>
                    <select
                        className="transport-rate"
                        aria-label="Narration speed"
                        value={transport.playbackRate}
                        onChange={(event) => transport.setRate(Number(event.target.value))}
                    >
                        {[0.75, 1, 1.25, 1.5, 2].map((rate) => (
                            <option key={rate} value={rate}>{rate}x</option>
                        ))}
                    </select>
                    <ChevronDown size={14} aria-hidden="true" className="transport-select-chevron" />
                </label>
                <label className="transport-sleep-control">
                    <span className="sr-only">Sleep timer</span>
                    <select
                        className="transport-sleep"
                        aria-label="Sleep timer"
                        value={sleep.minutes == null ? 'off' : String(sleep.minutes)}
                        onChange={handleSleepChange}
                    >
                        <option value="off">Sleep: Off</option>
                        {SLEEP_MINUTE_OPTIONS.map((option) => (
                            <option key={option} value={option}>{option} min</option>
                        ))}
                        <option value={SLEEP_END_OF_CHAPTER}>End of chapter</option>
                    </select>
                    {sleep.minutes === SLEEP_END_OF_CHAPTER ? (
                        <span className="transport-sleep-remaining">chapter end</span>
                    ) : sleep.remainingMs != null ? (
                        <span className="transport-sleep-remaining">{formatTime(sleep.remainingMs / 1000)}</span>
                    ) : null}
                    <ChevronDown size={14} aria-hidden="true" className="transport-select-chevron" />
                </label>
                {pageLabel ? <span className="transport-page">{pageLabel}</span> : null}
                {generating ? <span className="transport-status">Preparing audio…</span> : null}
                {transport.mediaError ? (
                    <span className="transport-error" role="alert">{transport.mediaError}</span>
                ) : null}
            </div>
            {/* Primary row: Play/Pause + scrubber + time */}
            <div className="transport-primary">
                <button
                    type="button"
                    className={`btn primary transport-play ${transport.isPlaying ? 'is-playing' : ''}`}
                    onClick={onToggle}
                    disabled={playDisabled}
                    aria-label={transport.isPlaying ? 'Pause narration' : 'Play narration'}
                    title={transport.isPlaying ? 'Pause narration' : 'Play narration'}
                >
                    {transport.isPlaying ? (
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                            <rect x="6" y="5" width="4" height="14" rx="1" />
                            <rect x="14" y="5" width="4" height="14" rx="1" />
                        </svg>
                    ) : (
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                            <path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86a1 1 0 00-1.5.86z" />
                        </svg>
                    )}
                </button>
                {showScrubber ? (
                    <input
                        type="range"
                        className="transport-scrubber"
                        aria-label="Narration position"
                        aria-valuetext={`${formatTime(elapsed)} elapsed, ${formatTime(Math.max(duration - elapsed, 0))} remaining`}
                        min={0}
                        max={Math.round(duration)}
                        step={1}
                        value={elapsed}
                        style={{ '--scrub-fill': `${duration ? (elapsed / duration) * 100 : 0}%` }}
                        onChange={handleSeek}
                    />
                ) : null}
                <span className="transport-time">
                    {formatTime(transport.currentTime)} / {formatTime(transport.duration)}
                </span>
            </div>
        </div>
    );
}
