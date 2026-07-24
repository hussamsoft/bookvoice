import React, { useEffect, useMemo, useState } from 'react';
import { PencilLine, Sparkles } from 'lucide-react';
import { createStudioNarration, createStudioRepair } from '../utils/api';
import { DEFAULT_STUDIO_SETTINGS } from '../utils/studio';
import StudioOutputs from './StudioOutputs';
import StudioSettings from './StudioSettings';
import StudioVoiceCloner from './StudioVoiceCloner';

export default function StudioNarration({ project, voices, onPatch, onRunJob, disabled }) {
    const [script, setScript] = useState(project.script || '');
    const [correction, setCorrection] = useState(null);
    const settings = { ...DEFAULT_STUDIO_SETTINGS, ...(project.generationSettings || {}) };

    useEffect(() => setScript(project.script || ''), [project.id, project.script]);
    useEffect(() => {
        if (script === (project.script || '')) return undefined;
        const timer = setTimeout(() => onPatch({ script }), 600);
        return () => clearTimeout(timer);
    }, [script, project.script, onPatch]);

    const narrations = useMemo(
        () => (project.outputs || []).filter((output) => output.kind === 'NARRATION'),
        [project.outputs],
    );
    const latest = narrations.at(-1) || null;
    const selectedVoice = voices.find((voice) => voice.id === project.voiceId) || null;

    const generate = () => onRunJob('Generating narration', () => createStudioNarration(project.id, {
        text: script,
        languageId: project.languageId || 'en',
        voiceId: project.voiceId || null,
        generationSettings: settings,
    }));

    const selectWord = (timing) => {
        const segment = (latest?.segments || []).find(
            (item) => timing.startSec >= item.startSec - 0.02 && timing.endSec <= item.endSec + 0.02,
        );
        setCorrection({
            assetId: latest.id,
            word: timing.word,
            startSec: segment?.startSec ?? timing.startSec,
            endSec: segment?.endSec ?? timing.endSec,
            text: segment?.text || timing.word,
        });
    };

    const repairSentence = async () => {
        await onRunJob('Rebuilding selected sentence', () => createStudioRepair(project.id, {
            assetId: correction.assetId,
            startSec: correction.startSec,
            endSec: correction.endSec,
            replacementText: correction.text,
            languageId: project.languageId || 'en',
            voiceId: project.voiceId || null,
            generationSettings: settings,
        }));
        setCorrection(null);
    };

    return (
        <div className="studio-workflow">
            <StudioVoiceCloner
                project={project}
                voices={voices}
                onPatch={onPatch}
                onRunJob={onRunJob}
                disabled={disabled}
            />

            <StudioSettings
                voices={voices}
                voiceId={project.voiceId}
                languageId={project.languageId}
                settings={settings}
                onVoiceChange={(voiceId) => onPatch({ voiceId })}
                onLanguageChange={(languageId) => onPatch({ languageId })}
                onSettingsChange={(generationSettings) => onPatch({ generationSettings })}
                disabled={disabled}
            />

            <section className="studio-editor" aria-labelledby="studio-script-heading">
                <div className="studio-section-heading">
                    <div>
                        <span className="studio-kicker">Step 2 · Write directly in BookVoice</span>
                        <h2 id="studio-script-heading">Narration script</h2>
                    </div>
                    <span className="studio-autosave">Saved locally</span>
                </div>
                <label className="sr-only" htmlFor="studio-script">Narration script</label>
                <textarea
                    id="studio-script"
                    value={script}
                    onChange={(event) => setScript(event.target.value)}
                    onBlur={() => {
                        if (script !== (project.script || '')) onPatch({ script });
                    }}
                    placeholder="Write the words you want this voice to narrate…"
                    dir={(project.languageId || 'en') === 'ar' ? 'rtl' : 'ltr'}
                    maxLength={200000}
                    disabled={disabled}
                />
                <div className="studio-editor-footer">
                    <span>{script.length.toLocaleString()} characters</span>
                    <button className="btn primary" onClick={generate} disabled={disabled || !script.trim()}>
                        <Sparkles size={16} /> {selectedVoice ? `Narrate with ${selectedVoice.name}` : 'Generate narration'}
                    </button>
                </div>
            </section>

            {latest && (
                <section className="studio-latest" aria-labelledby="studio-latest-heading">
                    <div className="studio-section-heading">
                        <div>
                            <span className="studio-kicker">Latest performance</span>
                            <h3 id="studio-latest-heading">Listen and correct</h3>
                        </div>
                    </div>
                    <audio controls preload="metadata" src={latest.contentUrl} />
                    {(latest.wordTimings || []).length > 0 && (
                        <div className="studio-transcript" aria-label="Select a word to correct">
                            {latest.wordTimings.map((timing, index) => (
                                <button key={`${timing.word}-${index}`} onClick={() => selectWord(timing)}>
                                    {timing.word}
                                </button>
                            ))}
                        </div>
                    )}
                    {correction && (
                        <div className="studio-correction">
                            <PencilLine size={18} />
                            <label>
                                <span>Edit the sentence containing “{correction.word}”</span>
                                <textarea value={correction.text} onChange={(e) => setCorrection({ ...correction, text: e.target.value })} rows={3} />
                            </label>
                            <div>
                                <button className="btn text" onClick={() => setCorrection(null)}>Cancel</button>
                                <button className="btn primary" onClick={repairSentence} disabled={!correction.text.trim() || disabled}>Create corrected version</button>
                            </div>
                        </div>
                    )}
                </section>
            )}

            <StudioOutputs
                projectId={project.id}
                outputs={project.outputs || []}
                onRunJob={onRunJob}
                disabled={disabled}
            />
        </div>
    );
}
