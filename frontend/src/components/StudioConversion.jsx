import React, { useEffect, useMemo, useState } from 'react';
import { Repeat2, ShieldCheck, Wand2 } from 'lucide-react';
import { createStudioConversion, uploadStudioSource } from '../utils/api';
import StudioOutputs from './StudioOutputs';
import MediaWorkbench from './studio/MediaWorkbench';
import AudioPlayer from './AudioPlayer';
import WaveformRange from './WaveformRange';

const MAX_TARGET_CLIP_SEC = 30;
const MIN_TARGET_CLIP_SEC = 5;
const TARGET_MODES = ['PROFILE', 'SOURCE'];

export default function StudioConversion({ project, voices, onPatch, onRunJob, disabled }) {
    const sources = useMemo(() => project.sources || [], [project.sources]);
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
        const dur = Number(sourceDurationSec) || 0.5;
        setRange({ start: 0, end: Math.max(0.5, Math.min(dur, 60 * 60)) });
        setConsent(false);
    }, [sourceId, sourceDurationSec]);


    const targetDurationSec = targetSource?.durationSec;
    useEffect(() => {
        if (!targetSourceId) return;
        const dur = Number(targetDurationSec) || MIN_TARGET_CLIP_SEC;
        setTargetRange({ start: 0, end: Math.min(dur, Math.max(MIN_TARGET_CLIP_SEC, Math.min(MAX_TARGET_CLIP_SEC, dur))) });
    }, [targetSourceId, targetDurationSec]);


    // Selecting whatever was just imported is the only sensible next step —
    // otherwise the picker keeps pointing at the previous file and the new one
    // looks like it never arrived.
    const selectImported = ({ sourceId: imported }) => {
        if (imported) setSourceId(imported);
    };

    const importFile = (file) =>
        onRunJob(
            'Importing recording',
            () => uploadStudioSource(project.id, file),
            { onComplete: selectImported, successMessage: () => `${file.name} imported and selected` },
        );

    const importRecording = async (blob, name) => {
        await onRunJob(
            'Importing recording',
            () => uploadStudioSource(
                project.id,
                new File([blob], name, { type: blob.type || 'audio/wav' }),
                { captureMethod: 'recording' },
            ),
            { onComplete: selectImported, successMessage: () => 'Recording added and selected' },
        );
    };

    // ARIA radio-group pattern: arrow keys move selection with roving
    // tabindex; mouse and touch keep their click behavior.
    const onTargetModeKeyDown = (event) => {
        const key = event.key;
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;
        const radios = Array.from(event.currentTarget.querySelectorAll('[role="radio"]'));
        const index = radios.indexOf(document.activeElement);
        if (index === -1) return;
        event.preventDefault();
        const direction = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
        const nextIndex = (index + direction + radios.length) % radios.length;
        setTargetMode(TARGET_MODES[nextIndex]);
        radios[nextIndex].focus();
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
                    <Repeat2 size={21} aria-hidden="true" />
                </div>
                <p className="studio-clone-intro">
                    The performance in the file is kept exactly as recorded — timing, rhythm and emphasis —
                    and only the voice is replaced. Nothing has to be re-typed and no generation controls
                    are involved.
                </p>

                <MediaWorkbench
                    sources={sources}
                    sourceId={sourceId}
                    onSourceIdChange={setSourceId}
                    onImportFile={importFile}
                    onRecorded={importRecording}
                    disabled={disabled}
                    inputAriaLabel="Recording media file"
                    recordLabel="Record something to convert"
                    retentionNote="Microphone recordings are deleted after 30 days."
                    pickerLabel="Recording to convert"
                    previewAriaLabel="Recording preview"
                    emptyPromptTitle="Choose the recording you want re-voiced"
                    range={{
                        ...range,
                        onChange: (start, end) => setRange({ start, end }),
                        idPrefix: 'studio-convert-source',
                        label: 'Region to convert',
                        note: (
                            <p className={validSource ? 'studio-range-note' : 'studio-range-note is-error'}>
                                Converting {sourceSpan.toFixed(1)} seconds. Leave the full range selected to
                                convert the whole recording.
                            </p>
                        ),
                    }}
                />
            </section>

            <section className="studio-profile-builder" aria-labelledby="studio-convert-target-heading">
                <div className="studio-section-heading">
                    <div>
                        <span className="studio-kicker">Step 2 · Pick the voice to speak it</span>
                        <h2 id="studio-convert-target-heading">Target voice</h2>
                    </div>
                    <Wand2 size={21} aria-hidden="true" />
                </div>

                <div
                    className="studio-target-modes"
                    role="radiogroup"
                    aria-label="Target voice source"
                    onKeyDown={onTargetModeKeyDown}
                >
                    <button
                        type="button"
                        role="radio"
                        aria-checked={targetMode === 'PROFILE'}
                        className={targetMode === 'PROFILE' ? 'is-active' : ''}
                        onClick={() => setTargetMode('PROFILE')}
                        tabIndex={targetMode === 'PROFILE' ? 0 : -1}
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
                        tabIndex={targetMode === 'SOURCE' ? 0 : -1}
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
                        <ShieldCheck size={16} aria-hidden="true" />
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
                    <AudioPlayer src={latest.contentUrl} label="the converted voice" />
                </section>
            )}

            <StudioOutputs outputs={conversions} />
        </div>
    );
}
