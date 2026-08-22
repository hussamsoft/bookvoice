import React from 'react';
import { Download, ScanText } from 'lucide-react';
import VoiceSettings from '../VoiceSettings';
import { SUPPORTED_LANGUAGES, languageName } from '../../utils/languages';

/**
 * Reading options drawer: voice, language, OCR, text editing, translation,
 * and whole-book preparation.
 */
export default function ReadingOptionsPanel({
    modelReady,
    activeVoiceId,
    onVoiceChange,
    targetLanguage,
    onLanguageChange,
    disabled,
    isOcring,
    onForceOcr,
    isEditingText,
    pageText,
    onToggleEditText,
    onTranslatePage,
    isGenerating,
    canPrepareBook,
    preparationRunning,
    onPrepareWholeBook,
    hasProfile,
    onCreatePreparedFile,
}) {
    return (
        <section className="reading-options" aria-label="Reading options panel">
            <VoiceSettings
                compact
                backendReady={modelReady}
                activeVoiceId={activeVoiceId}
                onVoiceChange={onVoiceChange}
            />
            <label className="reading-option-field">
                Language
                <select
                    value={targetLanguage}
                    onChange={(event) => onLanguageChange(event.target.value)}
                    disabled={disabled}
                >
                    {SUPPORTED_LANGUAGES.map((lang) => (
                        <option key={lang.code} value={lang.code}>
                            {lang.name}
                        </option>
                    ))}
                </select>
            </label>
            <div className="reading-option-field">
                <span className="field-label">Page tools</span>
                <div className="translation-toolbar">
                    <button
                        type="button"
                        className="btn secondary btn-compact"
                        onClick={onForceOcr}
                        disabled={disabled}
                    >
                        <ScanText size={15} aria-hidden="true" /> {isOcring ? 'Running OCR…' : 'Re-run OCR'}
                    </button>
                    <button
                        type="button"
                        className="btn secondary btn-compact"
                        onClick={onToggleEditText}
                        disabled={!pageText}
                    >
                        {isEditingText ? 'Cancel editing' : 'Edit text'}
                    </button>
                    <button type="button" className="btn secondary btn-compact" onClick={onTranslatePage} disabled={!pageText || isGenerating}>
                        Translate to {languageName(targetLanguage === 'ar' ? 'en' : 'ar')}
                    </button>
                </div>
            </div>
            <div className="reading-option-field">
                <span className="field-label">Whole book</span>
                <div className="translation-toolbar">
                    <button
                        type="button"
                        className="btn primary btn-compact"
                        onClick={onPrepareWholeBook}
                        disabled={!canPrepareBook || preparationRunning}
                    >
                        Prepare whole book
                    </button>
                    {hasProfile ? (
                        <button type="button" className="btn secondary btn-compact" onClick={onCreatePreparedFile}>
                            <Download size={15} aria-hidden="true" /> Save .bookvoice file
                        </button>
                    ) : null}
                </div>
            </div>
        </section>
    );
}
