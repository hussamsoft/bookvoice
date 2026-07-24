import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Mic2, Play, ShieldCheck, Upload } from 'lucide-react';
import { createStudioProfile, uploadStudioSource } from '../utils/api';
import WaveformRange from './WaveformRange';

function suggestedProfileName(fileName) {
    const base = String(fileName || 'Imported voice').replace(/\.[^.]+$/, '').trim();
    return `${base || 'Imported'} voice`;
}

export default function StudioVoiceCloner({ project, voices, onPatch, onRunJob, disabled }) {
    const fileRef = useRef(null);
    const mediaRef = useRef(null);
    const [sourceId, setSourceId] = useState(project.sources?.at(-1)?.id || '');
    const [range, setRange] = useState({ start: 0, end: 5 });
    const [profileName, setProfileName] = useState('');
    const [consent, setConsent] = useState(false);

    const source = useMemo(
        () => (project.sources || []).find((item) => item.id === sourceId) || null,
        [project.sources, sourceId],
    );
    const sourceDurationSec = source?.durationSec;
    const sourceFileName = source?.fileName;
    const selectedVoice = voices.find((voice) => voice.id === project.voiceId) || null;

    useEffect(() => {
        const sources = project.sources || [];
        if (!sources.some((item) => item.id === sourceId)) {
            setSourceId(sources.at(-1)?.id || '');
        }
    }, [project.id, project.sources, sourceId]);

    useEffect(() => {
        if (!sourceId) return;
        setRange({ start: 0, end: Math.min(10, sourceDurationSec || 5) });
        setProfileName(suggestedProfileName(sourceFileName));
        setConsent(false);
    }, [sourceDurationSec, sourceFileName, sourceId]);

    const upload = async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        await onRunJob('Importing voice media', () => uploadStudioSource(project.id, file));
        event.target.value = '';
    };

    const createAndSelectProfile = async () => {
        await onRunJob('Cloning imported voice', () => createStudioProfile(project.id, {
            sourceId: source.id,
            name: profileName,
            startSec: range.start,
            endSec: range.end,
            consentConfirmed: consent,
        }), {
            refreshVoices: true,
            onComplete: ({ voiceId }) => voiceId ? onPatch({ voiceId }) : null,
        });
        setConsent(false);
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

    const duration = range.end - range.start;
    const validRange = duration >= 5 && duration <= 30;

    return (
        <section className="studio-profile-builder studio-voice-cloner" aria-labelledby="studio-clone-heading">
            <div className="studio-section-heading">
                <div>
                    <span className="studio-kicker">Step 1 · Replicate the speaker</span>
                    <h2 id="studio-clone-heading">Clone a voice from media</h2>
                </div>
                <Mic2 size={21} />
            </div>
            <p className="studio-clone-intro">
                Import an audio or video recording, select one clean speaker, and BookVoice will narrate anything you write in that imported voice.
            </p>

            <div className="studio-clone-toolbar">
                <button className="btn secondary" type="button" onClick={() => fileRef.current?.click()} disabled={disabled}>
                    <Upload size={16} /> Import voice audio or video
                </button>
                <input
                    ref={fileRef}
                    type="file"
                    hidden
                    aria-label="Voice media file"
                    accept="audio/*,video/mp4,video/webm,.mov,.mkv,.m4a,.aac,.flac,.ogg"
                    onChange={upload}
                />
                {selectedVoice && (
                    <div className="studio-active-clone" role="status">
                        <span>Selected narration voice</span>
                        <strong>{selectedVoice.name}</strong>
                    </div>
                )}
            </div>

            {(project.sources || []).length > 0 && (
                <label className="studio-source-picker">
                    <span>Voice source</span>
                    <select value={sourceId} onChange={(event) => setSourceId(event.target.value)} disabled={disabled}>
                        {project.sources.map((item) => (
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
                                aria-label="Voice source video preview"
                                src={source.previewUrl || source.originalUrl}
                                onTimeUpdate={stopAtSelectionEnd}
                            />
                        ) : (
                            <audio ref={mediaRef} controls preload="metadata" src={source.originalUrl} onTimeUpdate={stopAtSelectionEnd} />
                        )}
                        <button className="btn text" type="button" onClick={playSelection} disabled={disabled}>
                            <Play size={15} /> Play selected voice sample
                        </button>
                    </div>
                    <WaveformRange
                        peaks={source.waveformPeaks}
                        duration={source.durationSec}
                        start={range.start}
                        end={range.end}
                        onChange={(start, end) => setRange({ start, end })}
                        disabled={disabled}
                    />
                    <p className={validRange ? 'studio-range-note' : 'studio-range-note is-error'}>
                        Select 5–30 seconds containing one person speaking clearly. Current selection: {duration.toFixed(1)} seconds.
                    </p>
                    <div className="studio-profile-fields">
                        <label>
                            <span>Profile name</span>
                            <input value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={64} disabled={disabled} />
                        </label>
                        <label className="studio-consent">
                            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={disabled} />
                            <span>I own or have permission to clone this voice.</span>
                        </label>
                        <button
                            className="btn primary"
                            type="button"
                            onClick={createAndSelectProfile}
                            disabled={disabled || !profileName.trim() || !consent || !validRange}
                        >
                            <ShieldCheck size={16} /> Create and use this voice
                        </button>
                    </div>
                </div>
            ) : (
                <button className="studio-drop-prompt" type="button" onClick={() => fileRef.current?.click()} disabled={disabled}>
                    <Upload size={28} />
                    <strong>Choose a recording of the voice to replicate</strong>
                    <span>WAV, MP3, M4A, AAC, FLAC, OGG, WebM, MP4, MOV, or MKV</span>
                </button>
            )}
        </section>
    );
}
