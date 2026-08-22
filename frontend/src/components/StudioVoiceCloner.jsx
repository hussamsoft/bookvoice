import React, { useEffect, useMemo, useState } from 'react';
import { Mic2, ShieldCheck } from 'lucide-react';
import { createStudioProfile, uploadStudioSource } from '../utils/api';
import MediaWorkbench from './studio/MediaWorkbench';

function suggestedProfileName(fileName) {
    const base = String(fileName || 'Imported voice').replace(/\.[^.]+$/, '').trim();
    return `${base || 'Imported'} voice`;
}

export default function StudioVoiceCloner({ project, voices, onPatch, onRunJob, disabled }) {
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

    const selectImported = ({ sourceId: imported }) => {
        if (imported) setSourceId(imported);
    };

    const importFile = (file) =>
        onRunJob(
            'Importing voice media',
            () => uploadStudioSource(project.id, file),
            { onComplete: selectImported, successMessage: () => `${file.name} imported and selected` },
        );

    const importRecording = async (blob, name) => {
        await onRunJob(
            'Importing voice media',
            () => uploadStudioSource(
                project.id,
                new File([blob], name, { type: blob.type || 'audio/wav' }),
                { captureMethod: 'recording' },
            ),
            { onComplete: selectImported, successMessage: () => 'Recording added and selected' },
        );
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
            // The imported recording already answers the questions the sliders
            // ask, so the derived settings are applied instead of leaving the
            // speaker's pace and expression to be rediscovered by hand.
            onComplete: ({ voiceId, suggestedSettings }) => {
                if (!voiceId) return null;
                return onPatch(
                    suggestedSettings
                        ? { voiceId, generationSettings: suggestedSettings }
                        : { voiceId },
                );
            },
            successMessage: ({ suggestedSettings }) => (
                suggestedSettings
                    ? 'Voice cloned and narration settings matched to the recording'
                    : 'Voice cloned'
            ),
        });
        setConsent(false);
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
                <Mic2 size={21} aria-hidden="true" />
            </div>
            <p className="studio-clone-intro">
                Import an audio or video recording, select one clean speaker, and BookVoice will narrate anything you write in that imported voice.
            </p>

            {selectedVoice && (
                <div className="studio-active-clone" role="status">
                    <span>Selected narration voice</span>
                    <strong>{selectedVoice.name}</strong>
                </div>
            )}

            <MediaWorkbench
                sources={project.sources || []}
                sourceId={sourceId}
                onSourceIdChange={setSourceId}
                onImportFile={importFile}
                onRecorded={importRecording}
                disabled={disabled}
                importButtonLabel="Import voice audio or video"
                inputAriaLabel="Voice media file"
                recordLabel="Record this voice"
                retentionNote="Microphone recordings are deleted after 30 days. Saved voices are shared across your devices."
                pickerLabel="Voice source"
                previewAriaLabel="Voice source video preview"
                previewPlayerLabel="the voice source"
                playSelectionLabel="Play selected voice sample"
                emptyPromptTitle="Choose a recording of the voice to replicate"
                range={{
                    ...range,
                    onChange: (start, end) => setRange({ start, end }),
                    note: (
                        <p className={validRange ? 'studio-range-note' : 'studio-range-note is-error'}>
                            Select 5–30 seconds containing one person speaking clearly. Current selection: {duration.toFixed(1)} seconds.
                        </p>
                    ),
                }}
            />

            {source && (
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
                        <ShieldCheck size={16} aria-hidden="true" /> Create and use this voice
                    </button>
                </div>
            )}
        </section>
    );
}
