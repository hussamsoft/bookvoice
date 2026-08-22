import React, { useCallback, useRef } from 'react';
import { Play, Upload } from 'lucide-react';
import AudioPlayer from '../AudioPlayer';
import StudioRecorder from '../StudioRecorder';
import WaveformRange from '../WaveformRange';

const ACCEPT = 'audio/*,video/mp4,video/webm,.mov,.mkv,.m4a,.aac,.flac,.ogg';

/**
 * The import / record / select / preview / range workbench shared by every
 * Voice Studio workflow that starts from a recording.
 *
 * Owns the hidden file input and the media element so selection playback is
 * implemented once instead of per tab.
 */
export default function MediaWorkbench({
    sources = [],
    sourceId,
    onSourceIdChange,
    onImportFile,
    onRecorded,
    disabled,
    importButtonLabel = 'Import audio or video',
    inputAriaLabel = 'Media file',
    recordLabel,
    retentionNote,
    pickerLabel = 'Recording',
    previewAriaLabel = 'Recording preview',
    previewPlayerLabel = 'the recording',
    playSelectionLabel = 'Play selected region',
    emptyPromptTitle = 'Choose a recording',
    emptyPromptHint = 'WAV, MP3, M4A, AAC, FLAC, OGG, WebM, MP4, MOV, or MKV',
    range,
}) {
    const fileRef = useRef(null);
    const mediaRef = useRef(null);

    const source = sources.find((item) => item.id === sourceId) || null;

    const playSelection = useCallback(() => {
        if (!mediaRef.current) return;
        mediaRef.current.currentTime = range.start;
        mediaRef.current.play();
    }, [range.start]);

    const stopAtSelectionEnd = useCallback(() => {
        if (mediaRef.current && mediaRef.current.currentTime >= range.end) {
            mediaRef.current.pause();
        }
    }, [range.end]);

    return (
        <>
            <div className="studio-clone-toolbar">
                <button className="btn secondary" type="button" onClick={() => fileRef.current?.click()} disabled={disabled}>
                    <Upload size={16} aria-hidden="true" /> {importButtonLabel}
                </button>
                <input
                    ref={fileRef}
                    type="file"
                    hidden
                    aria-label={inputAriaLabel}
                    accept={ACCEPT}
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file) onImportFile(file);
                    }}
                />
                {onRecorded ? (
                    <StudioRecorder onRecorded={onRecorded} disabled={disabled} label={recordLabel} />
                ) : null}
                {retentionNote ? <small className="studio-record-retention">{retentionNote}</small> : null}
            </div>

            {sources.length > 0 && (
                <label className="studio-source-picker">
                    <span>{pickerLabel}</span>
                    <select value={sourceId} onChange={(event) => onSourceIdChange(event.target.value)} disabled={disabled}>
                        {sources.map((item) => (
                            <option key={item.id} value={item.id}>{item.fileName}</option>
                        ))}
                    </select>
                </label>
            )}

            {source ? (
                <div className="studio-clone-workbench">
                    <div className="studio-clone-preview">
                        {source.mediaType === 'VIDEO' ? (
                            <video
                                ref={mediaRef}
                                controls
                                playsInline
                                preload="metadata"
                                aria-label={previewAriaLabel}
                                src={source.previewUrl || source.originalUrl}
                                onTimeUpdate={stopAtSelectionEnd}
                            />
                        ) : (
                            <AudioPlayer ref={mediaRef} src={source.originalUrl} onTimeUpdate={stopAtSelectionEnd} label={previewPlayerLabel} />
                        )}
                        <button className="btn text" type="button" onClick={playSelection} disabled={disabled}>
                            <Play size={15} aria-hidden="true" /> {playSelectionLabel}
                        </button>
                    </div>
                    {range ? (
                        <WaveformRange
                            peaks={source.waveformPeaks}
                            duration={source.durationSec}
                            start={range.start}
                            end={range.end}
                            onChange={range.onChange}
                            disabled={disabled}
                            idPrefix={range.idPrefix}
                            label={range.label}
                        />
                    ) : null}
                    {range?.note}
                </div>
            ) : (
                <button className="studio-drop-prompt" type="button" onClick={() => fileRef.current?.click()} disabled={disabled}>
                    <Upload size={28} aria-hidden="true" />
                    <strong>{emptyPromptTitle}</strong>
                    <span>{emptyPromptHint}</span>
                </button>
            )}
        </>
    );
}
