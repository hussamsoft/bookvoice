import React, { useMemo, useState, memo } from 'react';
import { formatClockTenths as timeLabel } from '../utils/format';

const WaveformRange = memo(function WaveformRange({
    peaks = [],
    duration = 0,
    start,
    end,
    onChange,
    disabled,
    idPrefix = 'studio-range',
    label = 'Selected speech range',
}) {
    const [zoom, setZoom] = useState(1);
    const safeDuration = Math.max(0.1, Number(duration) || 0.1);
    const windowDuration = safeDuration / zoom;
    const center = (start + end) / 2;
    const windowStart = Math.max(0, Math.min(safeDuration - windowDuration, center - windowDuration / 2));
    const windowEnd = windowStart + windowDuration;
    const bars = useMemo(() => {
        if (!peaks.length) return [];
        const first = Math.max(0, Math.floor((windowStart / safeDuration) * peaks.length));
        const last = Math.min(peaks.length, Math.ceil((windowEnd / safeDuration) * peaks.length));
        const visible = peaks.slice(first, last);
        const step = Math.max(1, Math.ceil(visible.length / 160));
        return visible.filter((_, index) => index % step === 0).slice(0, 160);
    }, [peaks, safeDuration, windowEnd, windowStart]);
    const startPercent = Math.min(100, Math.max(0, ((start - windowStart) / windowDuration) * 100));
    const endPercent = Math.min(100, Math.max(0, ((end - windowStart) / windowDuration) * 100));

    return (
        <fieldset className="studio-waveform" disabled={disabled}>
            <legend className="sr-only">{label}</legend>
            <div className="studio-waveform-heading">
                <strong>{label}</strong>
                <label>Zoom
                    <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
                        <option value="1">1×</option>
                        <option value="2">2×</option>
                        <option value="4">4×</option>
                        <option value="8">8×</option>
                    </select>
                </label>
            </div>
            <svg className="studio-waveform-plot" viewBox="0 0 100 48" preserveAspectRatio="none" aria-hidden="true">
                <rect className="studio-waveform-selection" x={startPercent} y="0" width={Math.max(0, endPercent - startPercent)} height="48" />
                <g className="studio-waveform-bars">
                    {bars.map((peak, index) => {
                        const height = Math.max(2, peak * 44);
                        const x = (index / Math.max(1, bars.length)) * 100;
                        return <rect key={index} x={x} y={(48 - height) / 2} width={Math.max(0.2, 85 / Math.max(1, bars.length))} height={height} />;
                    })}
                </g>
            </svg>
            <div className="studio-range-grid">
                <label htmlFor={`${idPrefix}-start`}>
                    <span>Start <output className="studio-waveform-output">{timeLabel(start)}</output></span>
                    <input
                        id={`${idPrefix}-start`}
                        type="range"
                        min="0"
                        max={safeDuration}
                        step="0.05"
                        value={start}
                        onChange={(event) => onChange(Math.min(Number(event.target.value), end - 0.25), end)}
                    />
                </label>
                <label htmlFor={`${idPrefix}-end`}>
                    <span>End <output className="studio-waveform-output">{timeLabel(end)}</output></span>
                    <input
                        id={`${idPrefix}-end`}
                        type="range"
                        min="0"
                        max={safeDuration}
                        step="0.05"
                        value={end}
                        onChange={(event) => onChange(start, Math.max(Number(event.target.value), start + 0.25))}
                    />
                </label>
            </div>
            <p>{(end - start).toFixed(2)} seconds selected. Use the arrow keys for precise adjustments.</p>
        </fieldset>
    );
});

export default WaveformRange;

