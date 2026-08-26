import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ScanText, SlidersHorizontal, X } from 'lucide-react';
import VoiceSettings from '../VoiceSettings';
import { SUPPORTED_LANGUAGES } from '../../utils/languages';

/**
 * Reading options with a self-managed trigger: anchored popover at >=1024px,
 * bottom sheet below (720-1023px shares the sheet). Text edit/translate live
 * beside the transcript; this surface holds voice, language, OCR and
 * whole-book preparation.
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
    canPrepareBook,
    preparationRunning,
    onPrepareWholeBook,
    hasProfile,
    onCreatePreparedFile,
    onExportAudiobook,
    onCancelExportAudiobook,
    isExportingAudiobook = false,
    audiobookProgress = null,
    isTextBook = false,
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef(null);
    const triggerRef = useRef(null);
    const panelRef = useRef(null);

    const close = useCallback(() => {
        setOpen(false);
        triggerRef.current?.focus();
    }, []);

    useEffect(() => {
        if (!open) return undefined;
        panelRef.current?.querySelector('button, select, input')?.focus();

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                close();
                return;
            }
            if (event.key !== 'Tab' || !panelRef.current) return;
            const focusable = panelRef.current.querySelectorAll(
                'button:not(:disabled), select:not(:disabled), input:not(:disabled)',
            );
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if ((event.shiftKey && document.activeElement === first)
                || (!event.shiftKey && document.activeElement === last)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            }
        };
        const onMouseDown = (event) => {
            if (rootRef.current && !rootRef.current.contains(event.target)) {
                setOpen(false);
            }
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('mousedown', onMouseDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('mousedown', onMouseDown);
        };
    }, [open, close]);

    return (
        <div className="reading-options-root" ref={rootRef}>
            <button
                ref={triggerRef}
                type="button"
                className="reading-options-trigger btn secondary btn-compact"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-haspopup="dialog"
            >
                <SlidersHorizontal size={15} aria-hidden="true" /> Reading options
            </button>
            {open ? (
                <>
                    <div className="reading-options-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
                    <section
                        ref={panelRef}
                        role="dialog"
                        aria-label="Reading options panel"
                        className="reading-options-popover"
                    >
                        <header className="reading-options-header">
                            <span>Reading options</span>
                            <button
                                type="button"
                                className="btn secondary btn-compact"
                                onClick={close}
                                aria-label="Close reading options"
                            >
                                <X size={15} aria-hidden="true" />
                            </button>
                        </header>
                        <VoiceSettings
                            compact
                            backendReady={modelReady}
                            activeVoiceId={activeVoiceId}
                            onVoiceChange={onVoiceChange}
                        />
                        <label className="reading-option-field reading-options-span">
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
                        <div className="reading-option-field reading-options-span">
                            <span className="field-label">Page tools</span>
                            {!isTextBook ? (
                                <button
                                    type="button"
                                    className="btn secondary btn-compact"
                                    onClick={onForceOcr}
                                    disabled={disabled}
                                >
                                    <ScanText size={15} aria-hidden="true" /> {isOcring ? 'Running OCR…' : 'Re-run OCR'}
                                </button>
                            ) : null}
                        </div>
                        <div className="reading-option-field reading-options-span">
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
                                    <>
                                        <button type="button" className="btn secondary btn-compact" onClick={onCreatePreparedFile}>
                                            <Download size={15} aria-hidden="true" /> Save .bookvoice file
                                        </button>
                                        {isExportingAudiobook ? (
                                            <button type="button" className="btn secondary btn-compact" onClick={onCancelExportAudiobook}>
                                                Cancel export
                                                {audiobookProgress && audiobookProgress.pageCount
                                                    ? ` (${audiobookProgress.pagesDone}/${audiobookProgress.pageCount})`
                                                    : ''}
                                            </button>
                                        ) : (
                                            <button type="button" className="btn secondary btn-compact" onClick={onExportAudiobook}>
                                                <Download size={15} aria-hidden="true" /> Export audiobook (.m4b)
                                            </button>
                                        )}
                                    </>
                                ) : null}
                            </div>
                        </div>
                    </section>
                </>
            ) : null}
        </div>
    );
}
