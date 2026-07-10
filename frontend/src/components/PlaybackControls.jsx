import React from 'react';
import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react';

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
}) {
    const canSeek = transport.duration > 0;
    return (
        <div className={`playback-transport ${compact ? 'compact' : ''}`}>
            <button
                type="button"
                className="btn secondary btn-compact"
                onClick={() => transport.skipBy(-10)}
                disabled={!canSeek}
                aria-label="Skip back 10 seconds"
                title="Back 10 seconds"
            >
                <RotateCcw size={15} />
            </button>
            <button
                type="button"
                className="btn primary transport-play"
                onClick={onToggle}
                disabled={disabled}
                aria-label={transport.isPlaying ? 'Pause narration' : 'Play narration'}
            >
                {transport.isPlaying ? <Pause size={16} /> : <Play size={16} />}
                {!compact && (transport.isPlaying ? 'Pause' : 'Play')}
            </button>
            <button
                type="button"
                className="btn secondary btn-compact"
                onClick={() => transport.skipBy(10)}
                disabled={!canSeek}
                aria-label="Skip forward 10 seconds"
                title="Forward 10 seconds"
            >
                <RotateCw size={15} />
            </button>
            <span className="transport-time">{formatTime(transport.currentTime)}</span>
            <input
                className="transport-seek"
                type="range"
                min="0"
                max={transport.duration || 0}
                step="0.05"
                value={Math.min(transport.currentTime, transport.duration || 0)}
                onChange={(event) => transport.seekTo(Number(event.target.value))}
                disabled={!canSeek}
                aria-label="Narration position"
            />
            <span className="transport-time">{formatTime(transport.duration)}</span>
            <button
                type="button"
                className="btn secondary btn-compact transport-rate"
                onClick={transport.cycleRate}
                aria-label={`Playback speed ${transport.playbackRate} times`}
                title="Playback speed"
            >
                {transport.playbackRate}x
            </button>
            {transport.mediaError ? (
                <span className="transport-error" role="alert">{transport.mediaError}</span>
            ) : null}
        </div>
    );
}
