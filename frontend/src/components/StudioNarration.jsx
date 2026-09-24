import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PencilLine, Sparkles } from 'lucide-react';
import { createStudioNarration, createStudioRepair } from '../utils/api';
import { DEFAULT_STUDIO_SETTINGS } from '../utils/studio';
import * as studioSession from '../utils/studioSession';
import AudioPlayer from './AudioPlayer';
import Modal from './ui/Modal';
import StudioOutputs from './StudioOutputs';
import StudioSettings from './StudioSettings';
import StudioVoiceCloner from './StudioVoiceCloner';

const SAMPLE_PROMPTS = [
    { label: 'Audiobook intro', text: 'The mist had crept over the valley before anyone noticed the lanterns going out in the old watchtower.' },
    { label: 'Podcast snippet', text: 'Welcome back to the studio. Today we are exploring something truly fascinating that changes how we listen.' },
    { label: 'Dramatic quote', text: 'I never promised that the path would be easy. I only promised that every single step would matter.' },
];

// Long narrations produce tens of thousands of timed words; rendering every
// correction button at once stalls low-end phones. Only a window around the
// last-clicked word (plus explicit '…' expansion) stays in the DOM.
const WORD_WINDOW = 25;
const WORD_CHUNK = 400;
const WORD_INLINE_LIMIT = 64;

const TranscriptWord = React.memo(function TranscriptWord({ timing, index, onSelect }) {
    return (
        <button type="button" onClick={() => onSelect(timing, index)}>
            {timing.word}
        </button>
    );
});

export default function StudioNarration({ project, voices, onPatch, onRunJob, disabled, _ttsStatus }) {
    // The draft is this device's own: typing on a phone must not overwrite
    // what is on screen at the desk. It falls back to the project's last
    // generated script the first time a device opens it.
    const [script, setScript] = useState(
        () => studioSession.getScript(project.id) ?? project.script ?? '',
    );
    const scriptRef = useRef(script);
    const draftDirtyRef = useRef(false);
    const [showCloner, setShowCloner] = useState(false);
    const [correction, setCorrection] = useState(null);
    const [transcriptRange, setTranscriptRange] = useState({ from: 0, to: WORD_WINDOW * 2 });
    const settings = useMemo(() => ({ ...DEFAULT_STUDIO_SETTINGS, ...(project.generationSettings || {}) }), [project.generationSettings]);
    const handleVoiceChange = useCallback((voiceId) => onPatch({ voiceId }), [onPatch]);
    const handleLanguageChange = useCallback((languageId) => onPatch({ languageId }), [onPatch]);
    const handleSettingsChange = useCallback((generationSettings) => onPatch({ generationSettings }), [onPatch]);

    useEffect(() => {
        const timer = setTimeout(() => studioSession.setScript(project.id, script), 400);
        return () => clearTimeout(timer);
    }, [script, project.id]);
    useLayoutEffect(() => () => {
        if (draftDirtyRef.current) studioSession.setScript(project.id, scriptRef.current);
    }, [project.id]);
    const updateScript = useCallback((value) => {
        draftDirtyRef.current = true;
        scriptRef.current = value;
        setScript(value);
    }, []);

    const narrations = useMemo(
        () => (project.outputs || []).filter((output) => output.kind === 'NARRATION'),
        [project.outputs],
    );
    const latest = narrations.at(-1) || null;
    const wordTimings = useMemo(() => latest?.wordTimings || [], [latest]);
    // A new performance invalidates the old correction window.
    const latestId = latest ? latest.id : null;
    useEffect(() => {
        setTranscriptRange({ from: 0, to: WORD_WINDOW * 2 });
    }, [latestId]);
    const selectedVoice = voices.find((voice) => voice.id === project.voiceId) || null;

    const wordCount = useMemo(() => {
        const trimmed = script.trim();
        return trimmed ? trimmed.split(/\s+/).length : 0;
    }, [script]);
    const estimatedSeconds = Math.round((wordCount / 140) * 60);
    const readTimeLabel = estimatedSeconds < 60
        ? `${estimatedSeconds}s read`
        : `${Math.floor(estimatedSeconds / 60)}m ${estimatedSeconds % 60}s read`;

    const generate = () => onRunJob('Generating narration', () => createStudioNarration(project.id, {
        text: script,
        languageId: project.languageId || 'en',
        voiceId: project.voiceId || null,
        generationSettings: settings,
    }));

    const onKeyDownTextarea = (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            if (!disabled && script.trim()) {
                generate();
            }
        }
    };

    const selectWord = useCallback((timing, index) => {
        const segment = (latest.segments || []).find(
            (item) => timing.startSec >= item.startSec - 0.02 && timing.endSec <= item.endSec + 0.02,
        );
        setCorrection({
            assetId: latest.id,
            word: timing.word,
            startSec: segment?.startSec ?? timing.startSec,
            endSec: segment?.endSec ?? timing.endSec,
            text: segment?.text || timing.word,
        });
        // Virtualization-lite: keep only the clicked word's neighbourhood in
        // the DOM; a click outside the current window recentres the slice.
        setTranscriptRange((current) => (
            index >= current.from && index < current.to
                ? current
                : {
                    from: Math.max(0, index - WORD_WINDOW),
                    to: Math.min(wordTimings.length, index + WORD_WINDOW + 1),
                }
        ));
    }, [latest, wordTimings]);

    const transcriptWindowed = wordTimings.length > WORD_INLINE_LIMIT;
    const visibleTimings = useMemo(
        () => wordTimings.slice(transcriptRange.from, transcriptRange.to),
        [wordTimings, transcriptRange],
    );

    const repairSentence = async () => {
        const success = await onRunJob('Rebuilding selected sentence', () => createStudioRepair(project.id, {
            assetId: correction.assetId,
            startSec: correction.startSec,
            endSec: correction.endSec,
            replacementText: correction.text,
            languageId: project.languageId || 'en',
            voiceId: project.voiceId || null,
            generationSettings: settings,
        }));
        if (success) setCorrection(null);
    };

    return (
        <div className="studio-workflow studio-workspace-grid">
            <aside className="studio-inspector" aria-label="Voice and delivery settings">
                <StudioSettings
                    voices={voices}
                    voiceId={project.voiceId}
                    languageId={project.languageId}
                    settings={settings}
                    onVoiceChange={handleVoiceChange}
                    onLanguageChange={handleLanguageChange}
                    onSettingsChange={handleSettingsChange}
                    onOpenCloner={() => setShowCloner(true)}
                    disabled={disabled}
                />

                <div className="studio-inspector-takes">
                    <StudioOutputs
                        outputs={project.outputs || []}
                    />
                </div>
            </aside>

            <main className="studio-stage" aria-label="Narration canvas and monitor">
                <section className="studio-editor" aria-labelledby="studio-script-heading">
                    <div className="studio-section-heading">
                        <div>
                            <span className="studio-kicker">Write directly in BookVoice</span>
                            <h2 id="studio-script-heading">Narration script</h2>
                        </div>
                        <div className="studio-editor-meta">
                            {wordCount > 0 && <span className="studio-read-time">{readTimeLabel}</span>}
                            <span className="studio-autosave">Saved locally</span>
                        </div>
                    </div>

                    <div className="studio-sample-prompts" role="group" aria-label="Sample test prompts">
                        <span className="studio-sample-prompts-label">Try a prompt:</span>
                        {SAMPLE_PROMPTS.map((prompt) => (
                            <button
                                key={prompt.label}
                                type="button"
                                className="studio-prompt-chip"
                                onClick={() => updateScript(prompt.text)}
                                disabled={disabled}
                            >
                                {prompt.label}
                            </button>
                        ))}
                    </div>

                    <label className="sr-only" htmlFor="studio-script">Narration script</label>
                    <textarea
                        id="studio-script"
                        value={script}
                        onChange={(event) => updateScript(event.target.value)}
                        onBlur={(event) => {
                            studioSession.setScript(project.id, event.currentTarget.value);
                            draftDirtyRef.current = false;
                        }}
                        onKeyDown={onKeyDownTextarea}
                        placeholder="Write the words you want this voice to narrate… (Ctrl+Enter to generate)"
                        dir={(project.languageId || 'en') === 'ar' ? 'rtl' : 'ltr'}
                        maxLength={200000}
                        disabled={disabled}
                    />
                    <div className="studio-editor-footer">
                        <div className="studio-editor-counts">
                            <span>{script.length.toLocaleString()} characters</span>
                            <span className="studio-count-bullet">•</span>
                            <span>{wordCount.toLocaleString()} words</span>
                        </div>
                        <div className="studio-editor-actions">
                            <span className="studio-shortcut-hint">Ctrl+Enter to generate</span>
                            <button className="btn primary" onClick={generate} disabled={disabled || !script.trim()}>
                                <Sparkles size={16} /> {selectedVoice ? `Narrate with ${selectedVoice.name}` : 'Generate narration'}
                            </button>
                        </div>
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
                        <AudioPlayer src={latest.contentUrl} label="the narration" />
                        {wordTimings.length > 0 && (
                            <div className="studio-transcript" aria-label="Select a word to correct" role="group">
                                {transcriptWindowed && transcriptRange.from > 0 && (

                                    <button
                                        type="button"

                                        className="studio-transcript-more"
                                        aria-label={`Show ${transcriptRange.from.toLocaleString()} earlier words`}
                                        onClick={() => setTranscriptRange((current) => ({
                                            ...current,
                                            from: Math.max(0, current.from - WORD_CHUNK),
                                        }))}
                                    >
                                        …
                                    </button>
                                )}
                                {visibleTimings.map((timing, offset) => (
                                    <TranscriptWord
                                        key={`${timing.word}-${transcriptRange.from + offset}`}
                                        timing={timing}
                                        index={transcriptRange.from + offset}
                                        onSelect={selectWord}
                                    />
                                ))}
                                {transcriptWindowed && transcriptRange.to < wordTimings.length && (
                                    <button
                                        type="button"
                                        className="studio-transcript-more"
                                        aria-label={`Show ${(wordTimings.length - transcriptRange.to).toLocaleString()} more words`}
                                        onClick={() => setTranscriptRange((current) => ({
                                            ...current,
                                            to: Math.min(wordTimings.length, current.to + WORD_CHUNK),
                                        }))}
                                    >
                                        …
                                    </button>
                                )}
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
            </main>

            <Modal
                open={showCloner}
                onClose={() => setShowCloner(false)}
                title="Voice Cloner"
                className="studio-cloner-modal"
            >
                <StudioVoiceCloner
                    project={project}
                    voices={voices}
                    onPatch={(patch) => {
                        onPatch(patch);
                        setShowCloner(false);
                    }}
                    onRunJob={onRunJob}
                    disabled={disabled}
                />
            </Modal>
        </div>
    );
}
