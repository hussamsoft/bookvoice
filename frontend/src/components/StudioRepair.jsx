import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileAudio, Scissors, ShieldCheck, Upload } from 'lucide-react';
import {
    createStudioProfile,
    createStudioRepair,
    exportStudioRepair,
    uploadStudioSource,
} from '../utils/api';
import { DEFAULT_STUDIO_SETTINGS } from '../utils/studio';
import StudioOutputs from './StudioOutputs';
import StudioSettings from './StudioSettings';
import WaveformRange from './WaveformRange';

export default function StudioRepair({ project, voices, onPatch, onRunJob, disabled }) {
    const fileRef = useRef(null);
    const mediaRef = useRef(null);
    const [sourceId, setSourceId] = useState(project.sources?.at(-1)?.id || '');
    const [range, setRange] = useState({ start: 0, end: 5 });
    const [profileName, setProfileName] = useState('');
    const [consent, setConsent] = useState(false);
    const [replacement, setReplacement] = useState('');
    const [loopSelection, setLoopSelection] = useState(false);
    const settings = { ...DEFAULT_STUDIO_SETTINGS, ...(project.generationSettings || {}) };
    const source = useMemo(
        () => (project.sources || []).find((item) => item.id === sourceId) || null,
        [project.sources, sourceId],
    );
    const latestRepair = [...(project.repairs || [])].reverse().find((item) => item.assetId === sourceId);
    const latestRepairOutput = (project.outputs || []).find((item) => item.id === latestRepair?.outputId);

    useEffect(() => {
        if (!sourceId && project.sources?.length) setSourceId(project.sources.at(-1).id);
    }, [project.sources, sourceId]);
    useEffect(() => {
        if (!source) return;
        setRange({ start: 0, end: Math.min(5, source.durationSec || 5) });
    }, [source]);

    const upload = async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        await onRunJob('Importing media', () => uploadStudioSource(project.id, file));
        event.target.value = '';
    };

    const createProfile = async () => {
        await onRunJob('Building voice profile', () => createStudioProfile(project.id, {
            sourceId: source.id,
            name: profileName,
            startSec: range.start,
            endSec: range.end,
            consentConfirmed: consent,
        }), {
            refreshVoices: true,
            onComplete: ({ voiceId }) => voiceId ? onPatch({ voiceId }) : null,
        });
        setProfileName('');
        setConsent(false);
    };

    const repair = () => onRunJob('Creating repair preview', () => createStudioRepair(project.id, {
        assetId: source.id,
        startSec: range.start,
        endSec: range.end,
        replacementText: replacement,
        languageId: project.languageId || 'en',
        voiceId: project.voiceId || null,
        generationSettings: settings,
    }));

    const exportVideo = () => onRunJob(
        'Exporting repaired video',
        () => exportStudioRepair(project.id, latestRepair.id),
    );

    const playSelection = () => {
        if (!mediaRef.current) return;
        mediaRef.current.currentTime = range.start;
        mediaRef.current.play();
    };

    const keepSelectionLooping = () => {
        if (!loopSelection || !mediaRef.current) return;
        if (mediaRef.current.currentTime >= range.end || mediaRef.current.currentTime < range.start) {
            mediaRef.current.currentTime = range.start;
            mediaRef.current.play();
        }
    };

    return (
        <div className="studio-workflow">
            <section className="studio-media-import" aria-labelledby="studio-media-heading">
                <div className="studio-section-heading">
                    <div>
                        <span className="studio-kicker">Original stays untouched</span>
                        <h2 id="studio-media-heading">Media source</h2>
                    </div>
                    <button className="btn secondary" onClick={() => fileRef.current?.click()} disabled={disabled}>
                        <Upload size={16} /> Import audio or video
                    </button>
                    <input ref={fileRef} type="file" hidden onChange={upload} accept="audio/*,video/mp4,video/webm,.mov,.mkv" />
                </div>
                {(project.sources || []).length === 0 ? (
                    <button className="studio-drop-prompt" onClick={() => fileRef.current?.click()} disabled={disabled}>
                        <FileAudio size={28} />
                        <strong>Choose an audio or video recording</strong>
                        <span>WAV, MP3, M4A, FLAC, OGG, WebM, MP4, MOV, or MKV</span>
                    </button>
                ) : (
                    <label className="studio-source-picker">
                        <span>Project source</span>
                        <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
                            {project.sources.map((item) => <option key={item.id} value={item.id}>{item.fileName}</option>)}
                        </select>
                    </label>
                )}
            </section>

            {source && <>
                <section className="studio-media-preview">
                    {source.mediaType === 'VIDEO' ? <video ref={mediaRef} controls playsInline preload="metadata" aria-label="Source video preview" src={source.previewUrl || source.originalUrl} onTimeUpdate={keepSelectionLooping} /> : <audio ref={mediaRef} controls preload="metadata" src={source.originalUrl} onTimeUpdate={keepSelectionLooping} />}
                    <div className="studio-loop-controls">
                        <button className="btn secondary" onClick={playSelection}>Play selected range</button>
                        <label><input type="checkbox" checked={loopSelection} onChange={(event) => setLoopSelection(event.target.checked)} /> Loop selection</label>
                    </div>
                    <WaveformRange peaks={source.waveformPeaks} duration={source.durationSec} start={range.start} end={range.end} onChange={(start, end) => setRange({ start, end })} disabled={disabled} />
                </section>

                <section className="studio-profile-builder" aria-labelledby="studio-profile-heading">
                    <div className="studio-section-heading">
                        <div><span className="studio-kicker">Reusable everywhere</span><h3 id="studio-profile-heading">Create voice profile</h3></div>
                        <ShieldCheck size={20} />
                    </div>
                    <p>Select 5–30 seconds of clean, single-speaker audio. BookVoice stores a normalized local profile.</p>
                    <div className="studio-profile-fields">
                        <label><span>Profile name</span><input value={profileName} onChange={(e) => setProfileName(e.target.value)} maxLength={64} /></label>
                        <label className="studio-consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>I own or have permission to clone this voice.</span></label>
                        <button className="btn secondary" onClick={createProfile} disabled={disabled || !profileName.trim() || !consent || range.end - range.start < 5 || range.end - range.start > 30}>Save voice profile</button>
                    </div>
                </section>

                <StudioSettings voices={voices} voiceId={project.voiceId} languageId={project.languageId} settings={settings} onVoiceChange={(voiceId) => onPatch({ voiceId })} onLanguageChange={(languageId) => onPatch({ languageId })} onSettingsChange={(generationSettings) => onPatch({ generationSettings })} disabled={disabled} />

                <section className="studio-repair-card" aria-labelledby="studio-repair-heading">
                    <div className="studio-section-heading"><div><span className="studio-kicker">Waveform-guided edit</span><h3 id="studio-repair-heading">Replace selected speech</h3></div><Scissors size={20} /></div>
                    <label><span>Corrected phrase</span><textarea value={replacement} onChange={(e) => setReplacement(e.target.value)} rows={3} placeholder="Type the complete corrected phrase for the selected range…" /></label>
                    <button className="btn primary" onClick={repair} disabled={disabled || !replacement.trim()}>Create A/B preview</button>
                    {latestRepairOutput && <div className="studio-ab-preview"><div><span>Original</span><audio controls preload="metadata" src={source.audioUrl} /></div><div><span>Repaired</span><audio controls preload="metadata" src={latestRepairOutput.contentUrl} /></div>{source.mediaType === 'VIDEO' && <button className="btn secondary" onClick={exportVideo} disabled={disabled}>Export repaired MP4</button>}</div>}
                </section>
            </>}

            <StudioOutputs
                projectId={project.id}
                outputs={project.outputs || []}
                onRunJob={onRunJob}
                disabled={disabled}
            />
        </div>
    );
}
