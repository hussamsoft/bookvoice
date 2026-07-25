import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Repeat2, ShieldCheck, Upload, Wand2 } from 'lucide-react';
import { createStudioConversion, uploadStudioSource } from '../utils/api';
import StudioOutputs from './StudioOutputs';
import StudioRecorder from './StudioRecorder';
import WaveformRange from './WaveformRange';

const MAX_TARGET_CLIP_SEC = 30;
const MIN_TARGET_CLIP_SEC = 5;

export default function StudioConversion({ project, voices, onPatch, onRunJob, disabled }) {
    const sources = useMemo(() => project.sources || [], [project.sources]);
    const mediaRef = useRef(null);
    const fileRef = useRef(null);
    const [sourceId, setSourceId] = useState(sources.at(-1)?.id || '');
    const [range, setRange] = useState({ start: 0, end: 0 });
    const [targetMode, setTargetMode] = useState('PROFILE');
    const [targetSourceId, setTargetSourceId] = useState('');
    const [targetRange, setTargetRange] = useState({ start: 0, end: 10 });
    const [consent, setConsent] = useState(false);

    const source = useMemo(
        () => sources.find((item) => item.id === sourceId) || null,
        [sources, sourceId],
    );
    const targetSource = useMemo(
        () => sources.find((item) => item.id === targetSourceId) || null,
        [sources, targetSourceId],
    );
    const selectedVoice = voices.find((voice) => voice.id === project.voiceId) || null;
    const conversions = useMemo(
        () => (project.outputs || []).filter((output) => output.kind === 'CONVERSION'),
        [project.outputs],
    );
    const latest = conversions.at(-1) || null;

    useEffect(() => {
        if (!sources.some((item) => item.id === sourceId)) {
            setSourceId(sources.at(-1)?.id || '');
        }
    }, [sources, sourceId]);

    const sourceDurationSec = source?.durationSec;
    useEffect(() => {
        if (!sourceId) return;
        setRange({ start: 0, end: Math.max(0.5, Number(sourceDurationSec) || 0.5) });
        setConsent(false);
    }, [sourceId, sourceDurationSec]);

    const targetDurationSec = targetSource?.durationSec;
    useEffect(() => {
        if (!targetSourceId) return;
        setTargetRange({ start: 0, end: Math.min(MAX_TARGET_CLIP_SEC, Math.max(MIN_TARGET_CLIP_SEC, Number(targetDurationSec) || MIN_TARGET_CLIP_SEC)) });
    }, [targetSourceId, targetDurationSec]);

    // Selecting whatever was just imported is the only sensible next step —
    // otherwise the picker keeps pointing at the previous file and the new one
    // looks like it never arrived.
    const selectImported = ({ sourceId: imported }) => {
        if (imported) setSourceId(imported);
    };

    const importMedia = async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        await onRunJob(
            'Importing recording',
            () => uploadStudioSource(project.id, file),
            { onComplete: selectImported, successMessage: () => `${file.name} imported and selected` },
        );
        event.target.value = '';
    };

    const importRecording = async (blob, name) => {
        await onRunJob(
            'Importing recording',
            () => uploadStudioSource(project.id, new File([blob], name, { type: blob.type || 'audio/wav' })),
            { onComplete: selectImported, successMessage: () => 'Recording added and selected' },
        );
    };

    const playSelection = () => {
        if (!mediaRef.current) return;
        mediaRef.current.currentTime = range.start;
        mediaRef.current.play();
    };

    const stopAtSelectionEnd = () => {
        if (mediaRef.current && mediaRef.current.currentTime >= range.end) {
            mediaRef.current.pause();
        }
    };

    const sourceSpan = range.end - range.start;
    const targetSpan = targetRange.end - targetRange.start;
    const validSource = Boolean(source) && sourceSpan >= 0.5;
    const validTarget = targetMode === 'PROFILE'
        ? Boolean(project.voiceId)
        : Boolean(targetSource) && targetSpan >= MIN_TARGET_CLIP_SEC && targetSpan <= MAX_TARGET_CLIP_SEC;

    const convert = () => onRunJob('Converting the recording', () => createStudioConversion(project.id, {
        sourceId: source.id,
        startSec: Number(range.start.toFixed(3)),
        endSec: Number(range.end.toFixed(3)),
        targetVoiceId: targetMode === 'PROFILE' ? project.voiceId : null,
        targetSourceId: targetMode === 'PROFILE' ? null : targetSource.id,
        targetStartSec: targetMode === 'PROFILE' ? null : Number(targetRange.start.toFixed(3)),
        targetEndSec: targetMode === 'PROFILE' ? null : Number(targetRange.end.toFixed(3)),
        consentConfirmed: consent,
    }), {
        successMessage: () => 'Converted recording added to the output history',
    });

    return (
        <div className="studio-workflow studio-conversion">
            <section className="studio-profile-builder" aria-labelledby="studio-convert-heading">
                <div className="studio-section-heading">
                    <div>
                        <span className="studio-kicker">Step 1 · Choose the recording to re-voice</span>
                        <h2 id="studio-convert-heading">Convert a recording into another voice</h2>
                    </div>
                    <Repeat2 size={21} />
                </div>
                <p className="studio-clone-intro">
                    The performance in the file is kept exactly as recorded — timing, rhythm and emphasis —
                    and only the voice is replaced. Nothing has to be re-typed and no generation controls
                    are involved.
                </p>

                <div className="studio-clone-toolbar">
                    <button className="btn secondary" type="button" onClick={() => fileRef.current?.click()} disabled={disabled}>
                        <Upload size={16} /> Import audio or video
                    </button>
                    <input
                        ref={fileRef}
                        type="file"
                        hidden
                        aria-label="Recording media file"
                        accept="audio/*,video/mp4,video/webm,.mov,.mkv,.m4a,.aac,.flac,.ogg"
                        onChange={importMedia}
                    />
                    <StudioRecorder
                        onRecorded={importRecording}
                        disabled={disabled}
                        label="Record something to convert"
                    />
                </div>

                {sources.length > 0 && (
                    <label className="studio-source-picker">
                        <span>Recording to convert</span>
                        <select value={sourceId} onChange={(event) => setSourceId(event.target.value)} disabled={disabled}>
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
                                    aria-label="Recording preview"
                                    src={source.previewUrl || source.originalUrl}
                                    onTimeUpdate={stopAtSelectionEnd}
                                />
                            ) : (
                                <audio ref={mediaRef} controls preload="metadata" src={source.originalUrl} onTimeUpdate={stopAtSelectionEnd} />
                            )}
                            <button className="btn text" type="button" onClick={playSelection} disabled={disabled}>
                                <Play size={15} /> Play selected region
                            </button>
                        </div>
                        <WaveformRange
                            peaks={source.waveformPeaks}
                            duration={source.durationSec}
                            start={range.start}
                            end={range.end}
                            onChange={(start, end) => setRange({ start, end })}
                            disabled={disabled}
                            idPrefix="studio-convert-source"
                            label="Region to convert"
                        />
                        <p className={validSource ? 'studio-range-note' : 'studio-range-note is-error'}>
                            Converting {sourceSpan.toFixed(1)} seconds. Leave the full range selected to
                            convert the whole recording.
                        </p>
                    </div>
                ) : (
                    <button className="studio-drop-prompt" type="button" onClick={() => fileRef.current?.click()} disabled={disabled}>
                        <Upload size={28} />
                        <strong>Choose the recording you want re-voiced</strong>
                        <span>WAV, MP3, M4A, AAC, FLAC, OGG, WebM, MP4, MOV, or MKV</span>
                    </button>
                )}
            </section>

            <section className="studio-profile-builder" aria-labelledby="studio-convert-target-heading">
                <div className="studio-section-heading">
                    <div>
                        <span className="studio-kicker">Step 2 · Pick the voice to speak it</span>
                        <h2 id="studio-convert-target-heading">Target voice</h2>
                    </div>
                    <Wand2 size={21} />
                </div>

                <div className="studio-target-modes" role="radiogroup" aria-label="Target voice source">
                    <button
                        type="button"
                        role="radio"
                        aria-checked={targetMode === 'PROFILE'}
                        className={targetMode === 'PROFILE' ? 'is-active' : ''}
                        onClick={() => setTargetMode('PROFILE')}
                        disabled={disabled}
                    >
                        <strong>Saved voice</strong>
                        <small>Use a voice already in your library</small>
                    </button>
                    <button
                        type="button"
                        role="radio"
                        aria-checked={targetMode === 'SOURCE'}
                        className={targetMode === 'SOURCE' ? 'is-active' : ''}
                        onClick={() => setTargetMode('SOURCE')}
                        disabled={disabled}
                    >
                        <strong>Another recording</strong>
                        <small>Take the voice straight from a file</small>
                    </button>
                </div>

                {targetMode === 'PROFILE' ? (
                    <label className="studio-source-picker">
                        <span>Voice profile</span>
                        <select
                            value={project.voiceId || ''}
                            onChange={(event) => onPatch({ voiceId: event.target.value || null })}
                            disabled={disabled}
                        >
                            <option value="">Select a voice…</option>
                            {voices.map((voice) => (
                                <option key={voice.id} value={voice.id}>{voice.name}</option>
                            ))}
                        </select>
                    </label>
                ) : (
                    <>
                        <label className="studio-source-picker">
                            <span>Voice reference recording</span>
                            <select
                                value={targetSourceId}
                                onChange={(event) => setTargetSourceId(event.target.value)}
                                disabled={disabled}
                            >
                                <option value="">Select a recording…</option>
                                {sources.map((item) => (
                                    <option key={item.id} value={item.id}>{item.fileName}</option>
                                ))}
                            </select>
                        </label>
                        {targetSource && (
                            <>
                                <WaveformRange
                                    peaks={targetSource.waveformPeaks}
                                    duration={targetSource.durationSec}
                                    start={targetRange.start}
                                    end={targetRange.end}
                                    onChange={(start, end) => setTargetRange({ start, end })}
                                    disabled={disabled}
                                    idPrefix="studio-convert-target"
                                    label="Voice reference range"
                                />
                                <p className={validTarget ? 'studio-range-note' : 'studio-range-note is-error'}>
                                    Select {MIN_TARGET_CLIP_SEC}–{MAX_TARGET_CLIP_SEC} seconds of the target
                                    speaker alone. Current selection: {targetSpan.toFixed(1)} seconds.
                                </p>
                            </>
                        )}
                    </>
                )}

                <div className="studio-profile-fields">
                    <label className="studio-consent">
                        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={disabled} />
                        <span>I own or have permission to use both the recording and the target voice.</span>
                    </label>
                    <button
                        className="btn primary"
                        type="button"
                        onClick={convert}
                        disabled={disabled || !consent || !validSource || !validTarget}
                    >
                        <ShieldCheck size={16} />
                        {targetMode === 'PROFILE' && selectedVoice
                            ? `Convert to ${selectedVoice.name}`
                            : 'Convert this recording'}
                    </button>
                </div>
            </section>

            {latest && (
                <section className="studio-latest" aria-labelledby="studio-converted-heading">
                    <div className="studio-section-heading">
                        <div>
                            <span className="studio-kicker">Latest conversion</span>
                            <h3 id="studio-converted-heading">Listen to the converted voice</h3>
                        </div>
                    </div>
                    <audio controls preload="metadata" src={latest.contentUrl} />
                </section>
            )}

            <StudioOutputs
                projectId={project.id}
                outputs={conversions}
                onRunJob={onRunJob}
                disabled={disabled}
            />
        </div>
    );
}
