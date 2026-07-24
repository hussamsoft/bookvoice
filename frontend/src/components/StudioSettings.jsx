import React from 'react';
import { DEFAULT_STUDIO_SETTINGS } from '../utils/studio';

function NumberControl({
    id,
    label,
    value,
    min,
    max,
    step,
    onChange,
    hint,
    description,
    lowLabel,
    highLabel,
    valueLabel,
    disabled,
}) {
    const helpId = `${id}-help`;
    return (
        <label className="studio-setting" htmlFor={id}>
            <span>{label}<small>{hint}</small></span>
            <p id={helpId} className="studio-setting-help">{description}</p>
            <div>
                <input
                    id={id}
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(event) => onChange(Number(event.target.value))}
                    disabled={disabled}
                    aria-describedby={helpId}
                    aria-valuetext={`${valueLabel}, ${Number(value).toFixed(step < 0.1 ? 2 : 1)}`}
                />
                <output htmlFor={id}>{Number(value).toFixed(step < 0.1 ? 2 : 1)}</output>
            </div>
            <div className="studio-setting-scale" aria-hidden="true">
                <span>{lowLabel}</span>
                <strong>{valueLabel}</strong>
                <span>{highLabel}</span>
            </div>
        </label>
    );
}

function paceLabel(value) {
    if (value < 0.93) return 'Slower';
    if (value > 1.07) return 'Faster';
    return 'Natural pace';
}

function expressionLabel(value) {
    if (value < 0.3) return 'Calm';
    if (value < 0.65) return 'Natural';
    if (value < 0.85) return 'Expressive';
    return 'Animated';
}

function temperatureLabel(value) {
    if (value < 0.5) return 'Consistent';
    if (value < 0.9) return 'Natural';
    if (value < 1.2) return 'Varied';
    return 'Experimental';
}

export default function StudioSettings({
    voices,
    voiceId,
    languageId,
    settings,
    onVoiceChange,
    onLanguageChange,
    onSettingsChange,
    disabled,
}) {
    const current = { ...DEFAULT_STUDIO_SETTINGS, ...(settings || {}) };
    const selectedVoice = voices.find((voice) => voice.id === voiceId);
    const update = (key, value) => onSettingsChange({ ...current, [key]: value });

    return (
        <section className="studio-settings" aria-labelledby="studio-voice-settings">
            <div className="studio-section-heading">
                <div>
                    <span className="studio-kicker">Voice direction</span>
                    <h3 id="studio-voice-settings">Voice and delivery</h3>
                </div>
                <button
                    className="btn text"
                    type="button"
                    onClick={() => onSettingsChange({ ...DEFAULT_STUDIO_SETTINGS })}
                    disabled={disabled}
                >
                    Reset controls
                </button>
            </div>

            <div className="studio-select-row">
                <label>
                    <span>Voice profile</span>
                    <select value={voiceId || ''} onChange={(e) => onVoiceChange(e.target.value || null)} disabled={disabled}>
                        <option value="">BookVoice Natural</option>
                        {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
                    </select>
                </label>
                <label>
                    <span>Language</span>
                    <select value={languageId || 'en'} onChange={(e) => onLanguageChange(e.target.value)} disabled={disabled}>
                        <option value="en">English</option>
                        <option value="ar">Arabic</option>
                    </select>
                </label>
            </div>

            {selectedVoice?.quality && (
                <div className={`studio-voice-quality ${(selectedVoice.quality.warnings || []).length ? 'has-warnings' : ''}`}>
                    <strong>Reference quality</strong>
                    <span>{selectedVoice.quality.durationSec.toFixed(1)}s · {selectedVoice.quality.rmsDb.toFixed(1)} dB RMS · {selectedVoice.quality.clippingPercent.toFixed(2)}% clipped</span>
                    {(selectedVoice.quality.warnings || []).map((warning) => <p key={warning}>{warning}</p>)}
                </div>
            )}

            <details className="studio-advanced" open>
                <summary>Advanced delivery controls</summary>
                <p>These shape the generated performance. They cannot reproduce exact original inflection.</p>
                <div className="studio-settings-grid">
                    <NumberControl
                        id="studio-pace"
                        label="Pace"
                        hint="0.75–1.25×"
                        description="Slower keeps the original pitch and adds time; faster shortens the delivery without raising the pitch."
                        lowLabel="Slower"
                        highLabel="Faster"
                        valueLabel={paceLabel(current.pace)}
                        value={current.pace}
                        min="0.75"
                        max="1.25"
                        step="0.05"
                        onChange={(v) => update('pace', v)}
                        disabled={disabled}
                    />
                    <NumberControl
                        id="studio-expression"
                        label="Expression"
                        hint="Performance intensity"
                        description="Increase for stronger emphasis and emotion. The safe range avoids the doubled, hall-like sound of extreme model exaggeration."
                        lowLabel="Calmer delivery"
                        highLabel="More animated delivery"
                        valueLabel={expressionLabel(current.expression)}
                        value={current.expression}
                        min="0"
                        max="1"
                        step="0.05"
                        onChange={(v) => update('expression', v)}
                        disabled={disabled}
                    />
                    <NumberControl
                        id="studio-temperature"
                        label="Temperature"
                        hint="Performance variation"
                        description="Lower values repeat a steadier reading; higher values introduce more variation between generations."
                        lowLabel="More consistent"
                        highLabel="More varied"
                        valueLabel={temperatureLabel(current.temperature)}
                        value={current.temperature}
                        min="0.1"
                        max="1.5"
                        step="0.05"
                        onChange={(v) => update('temperature', v)}
                        disabled={disabled}
                    />
                    <label className="studio-setting studio-guidance">
                        <span>Guidance<small>Auto is recommended</small></span>
                        <p id="studio-guidance-help" className="studio-setting-help">
                            Lower guidance gives the voice more freedom; higher guidance follows the selected voice more strictly. Auto adapts safely to Expression.
                        </p>
                        <input
                            id="studio-guidance"
                            type="number"
                            min="0"
                            max="1"
                            step="0.05"
                            value={current.guidance ?? ''}
                            placeholder="Auto"
                            onChange={(e) => update('guidance', e.target.value === '' ? null : Number(e.target.value))}
                            disabled={disabled}
                            aria-describedby="studio-guidance-help"
                        />
                        <div className="studio-setting-scale" aria-hidden="true">
                            <span>More freedom</span>
                            <strong>{current.guidance == null ? 'Auto' : 'Manual'}</strong>
                            <span>Stricter match</span>
                        </div>
                    </label>
                    <label className="studio-setting studio-seed">
                        <span>Variation seed<small>Blank creates a fresh variation</small></span>
                        <p id="studio-seed-help" className="studio-setting-help">
                            Enter the same number to repeat a variation on the same BookVoice runtime and hardware. Leave blank for a new random performance.
                        </p>
                        <input
                            id="studio-seed"
                            type="number"
                            min="0"
                            max="4294967295"
                            step="1"
                            value={current.seed ?? ''}
                            placeholder="Random"
                            onChange={(e) => update('seed', e.target.value === '' ? null : Number(e.target.value))}
                            disabled={disabled}
                            aria-describedby="studio-seed-help"
                        />
                        <div className="studio-setting-scale" aria-hidden="true">
                            <span>Fresh take</span>
                            <strong>{current.seed == null ? 'Random' : 'Repeatable'}</strong>
                            <span>Same seed</span>
                        </div>
                    </label>
                </div>
            </details>
        </section>
    );
}
