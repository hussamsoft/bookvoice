import React, { useState, useCallback, useMemo, memo } from 'react';


const NumberControl = memo(function NumberControl({
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
            <div className="studio-setting-label">
                <span className="studio-setting-label-text">{label}</span>
                {hint && <span className="studio-setting-hint" id={helpId}>{hint}</span>}
            </div>
            <div className="studio-setting-control">
                <input
                    id={id}
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }}
                    disabled={disabled}
                    aria-describedby={helpId}
                />
                <span className="studio-setting-value">
                    {valueLabel ? valueLabel(value) : value}
                </span>
            </div>
            {description && <div className="studio-setting-description">{description}</div>}
            <div className="studio-setting-scale" aria-hidden="true">
                <span>{lowLabel}</span>
                <strong>{valueLabel ? valueLabel(value) : value}</strong>
                <span>{highLabel}</span>
            </div>
        </label>
    );
});


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
    if (value < 0.5) return 'Cold';
    if (value < 0.8) return 'Natural';
    if (value < 1.2) return 'Balanced';
    return 'Warm';
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
    const [showAdvanced, setShowAdvanced] = useState(true);
    const [showVariation, setShowVariation] = useState(true);

    const handlePaceChange = useCallback((value) => {
        const newSettings = { ...settings, pace: value };
        onSettingsChange(newSettings);
    }, [settings, onSettingsChange]);

    const handleExpressionChange = useCallback((value) => {
        const newSettings = { ...settings, expression: value };
        onSettingsChange(newSettings);
    }, [settings, onSettingsChange]);

    const handleTemperatureChange = useCallback((value) => {
        const newSettings = { ...settings, temperature: value };
        onSettingsChange(newSettings);
    }, [settings, onSettingsChange]);

    const handleGuidanceChange = useCallback((value) => {
        const newSettings = { ...settings, guidance: value };
        onSettingsChange(newSettings);
    }, [settings, onSettingsChange]);

    const handleSeedChange = useCallback((value) => {
        const newSettings = { ...settings, seed: value };
        onSettingsChange(newSettings);
    }, [settings, onSettingsChange]);

    const deliverySettings = useMemo(() => ({ pace: settings.pace, expression: settings.expression, temperature: settings.temperature }), [settings.pace, settings.expression, settings.temperature]);
    const variationSettings = useMemo(() => ({ guidance: settings.guidance ?? null, seed: settings.seed ?? null }), [settings.guidance, settings.seed]);


    return (
        <div className="studio-settings" role="region" aria-label="Generation settings">
            {/* Essential Settings Section */}
            <section className="studio-settings-section" aria-labelledby="essential-heading">
                <div className="studio-section-header">
                    <div className="studio-section-kicker">Core settings</div>
                    <h3 id="essential-heading">Voice & Language</h3>
                </div>

                <div className="studio-settings-grid">
                    <div className="studio-setting-item">
                        <label className="studio-setting-label" htmlFor="studio-voice-select">Voice</label>
                        <select
                            id="studio-voice-select"
                            value={voiceId}
                            onChange={(e) => onVoiceChange(e.target.value)}
                            disabled={disabled}
                            className="studio-select"
                        >
                            {(voices || []).map((voice) => (
                                <option key={voice.id} value={voice.id}>{voice.name}</option>
                            ))}
                        </select>
                    </div>

                    <div className="studio-setting-item">
                        <label className="studio-setting-label" htmlFor="language-select">Language</label>
                        <select
                            id="language-select"
                            value={languageId}
                            onChange={(e) => onLanguageChange(e.target.value)}
                            disabled={disabled}
                            className="studio-select"
                        >
                            <option value="en">English</option>
                            <option value="es">Spanish</option>
                            <option value="fr">French</option>
                            <option value="de">German</option>
                        </select>
                    </div>
                </div>
            </section>

            {/* Advanced Delivery Section */}
            <section className="studio-settings-section">
                <button
                    type="button"
                    className="studio-section-header"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    aria-expanded={showAdvanced}
                    aria-controls="advanced-delivery-section"
                >
                    <span className="studio-section-kicker">Advanced delivery</span>
                    <span className="studio-section-title">Speed & Expression</span>
                    <span className="studio-section-toggle" aria-hidden="true">
                        {showAdvanced ? '−' : '+'}
                    </span>
                </button>

                {showAdvanced && (
                    <div id="advanced-delivery-section" className="studio-settings-grid">
                        <div className="studio-setting-item">
                            <NumberControl
                                id="pace"
                                label="Pace"
                                value={deliverySettings.pace}
                                min={0.5}
                                max={1.5}
                                step={0.01}
                                onChange={handlePaceChange}
                                hint={paceLabel(deliverySettings.pace)}
                                description="Slower keeps the original pitch and adds time; faster shortens the delivery without raising the pitch."
                                lowLabel="Slower"
                                highLabel="Faster"
                                valueLabel={paceLabel}
                                disabled={disabled}
                            />
                        </div>

                        <div className="studio-setting-item">
                            <NumberControl
                                id="expression"
                                label="Expression"
                                value={deliverySettings.expression}
                                min={0}
                                max={1}
                                step={0.01}
                                onChange={handleExpressionChange}
                                hint={expressionLabel(deliverySettings.expression)}
                                description="Increase for stronger emphasis and emotion. The safe range avoids the doubled, hall-like sound of extreme model exaggeration."
                                lowLabel="Calmer delivery"
                                highLabel="More animated delivery"
                                valueLabel={expressionLabel}
                                disabled={disabled}
                            />
                        </div>

                        <div className="studio-setting-item">
                            <NumberControl
                                id="temperature"
                                label="Temperature"
                                value={deliverySettings.temperature}
                                min={0}
                                max={2}
                                step={0.01}
                                onChange={handleTemperatureChange}
                                hint={temperatureLabel(deliverySettings.temperature)}
                                description="Lower values repeat a steadier reading; higher values introduce more variation between generations."
                                lowLabel="More consistent"
                                highLabel="More varied"
                                valueLabel={temperatureLabel}
                                disabled={disabled}
                            />
                        </div>
                    </div>
                )}
            </section>
            {/* Variation Section */}
            <section className="studio-settings-section">
                <button
                    type="button"
                    className="studio-section-header"
                    onClick={() => setShowVariation(!showVariation)}
                    aria-expanded={showVariation}
                    aria-controls="variation-section"
                >
                    <span className="studio-section-kicker">Variation</span>
                    <span className="studio-section-title">Guidance & Randomness</span>
                    <span className="studio-section-toggle" aria-hidden="true">
                        {showVariation ? '−' : '+'}
                    </span>
                </button>

                {showVariation && (
                    <div id="variation-section" className="studio-settings-grid">
                        <div className="studio-setting-item">
                            <NumberControl
                                id="guidance"
                                label="Guidance"
                                value={variationSettings.guidance ?? 0.5}
                                min={0}
                                max={1}
                                step={0.01}
                                onChange={handleGuidanceChange}
                                hint={variationSettings.guidance == null ? 'Auto' : variationSettings.guidance.toFixed(2)}
                                description="Lower guidance gives the voice more freedom; higher guidance follows the selected voice more strictly. Auto adapts safely to Expression."
                                lowLabel="Loose"
                                highLabel="Strict"
                                valueLabel={(v) => variationSettings.guidance == null ? 'Auto' : v.toFixed(2)}
                                disabled={disabled}
                            />
                        </div>

                        <div className="studio-setting-item">
                            <NumberControl
                                id="seed"
                                label="Seed"
                                value={variationSettings.seed ?? 0}
                                min={0}
                                max={1000000}
                                step={1}
                                onChange={handleSeedChange}
                                hint={variationSettings.seed == null ? 'Random' : variationSettings.seed}
                                description="Reproducible random seed"
                                lowLabel="Low"
                                highLabel="High"
                                valueLabel={(v) => variationSettings.seed == null ? 'Random' : v}
                                disabled={disabled}
                            />
                        </div>
                    </div>
                )}
            </section>
        </div>
    );
}