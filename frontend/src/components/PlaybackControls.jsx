import React from 'react';
import { Pause, Play, RotateCcw, RotateCw, Square } from 'lucide-react';

function formatTime(value) {
    if (!Number.isFinite(value) || value < 0) return '0:00';
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
}

export default function PlaybackControls({
    transport,
    onToggle = transport.toggle,
    disabled = false,
    compact = false,
    generating = false,
    hasMedia = false,
    onStop,
    followNarration = false,
    onFollowChange,
    pageLabel = '',
}) {
    const canSeek = transport.duration > 0;
    const playDisabled = disabled && !transport.isPlaying;
    const canStop = generating || hasMedia || transport.isPlaying;
    return (
        <div className={`playback-transport ${compact ? 'compact' : ''}`}>
            <button
                type="button"
                className="btn secondary btn-compact transport-stop"
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
                className="btn secondary btn-compact transport-skip"
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
                className="btn primary transport-play"
                onClick={onToggle}
                disabled={playDisabled}
                aria-label={transport.isPlaying ? 'Pause narration' : 'Play narration'}
                title={transport.isPlaying ? 'Pause narration' : 'Play narration'}
            >
                {transport.isPlaying ? <Pause size={16} /> : <Play size={16} />}
                {!compact && (transport.isPlaying ? 'Pause' : 'Play')}
            </button>
            <button
                type="button"
                className="btn secondary btn-compact transport-skip"
                onClick={() => transport.skipBy(10)}
                disabled={!canSeek}
                aria-label="Skip forward 10 seconds"
                title="Forward 10 seconds"
            >
                <RotateCw size={15} />
                <span className="transport-label">Forward 10</span>
            </button>
            <span className="transport-time">
                {formatTime(transport.currentTime)} / {formatTime(transport.duration)}
            </span>
            <button
                type="button"
                className="btn secondary btn-compact transport-rate"
                onClick={transport.cycleRate}
                aria-label={`Playback speed ${transport.playbackRate} times`}
                title="Playback speed"
            >
                {transport.playbackRate}x
            </button>
            {pageLabel ? <span className="transport-page">{pageLabel}</span> : null}
            {onFollowChange ? (
                <label className="transport-follow">
                    <input
                        type="checkbox"
                        checked={followNarration}
                        onChange={(event) => onFollowChange(event.target.checked)}
                    />
                    Follow narration
                </label>
            ) : null}
            {generating ? <span className="transport-status">Preparing audio…</span> : null}
            {transport.mediaError ? (
                <span className="transport-error" role="alert">{transport.mediaError}</span>
            ) : null}
        </div>
    );
}
