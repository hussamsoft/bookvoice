import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScanText, SlidersHorizontal, X } from 'lucide-react';
import VoiceSettings from '../VoiceSettings';
import { SUPPORTED_LANGUAGES } from '../../utils/languages';

/**
 * Reading options with a self-managed trigger: anchored popover at >=1024px,
 * bottom sheet below. Voice + language stay inline; whole-book actions live
 * in the reader's Book menu, not here.
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

    // Initial focus: only when panel opens.
    useEffect(() => {
        if (!open) return;
        panelRef.current?.querySelector('button, select, input')?.focus();
    }, [open]);

    useEffect(() => {
        if (!open) return undefined;

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
                close();
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
                <SlidersHorizontal size={15} aria-hidden="true" /> Voice &amp; options
            </button>
            {open ? (
                <>
                    <button
                        type="button"
                        aria-label="Dismiss"
                        className="reading-options-scrim"
                        onClick={() => setOpen(false)}
                        aria-hidden="true"
                    />
                    <section
                        ref={panelRef}
                        role="dialog"
                        aria-label="Reading options panel"
                        className="reading-options-popover"
                    >
                        <header className="reading-options-header">
                            <span>Voice &amp; options</span>
                            <button
                                type="button"
                                className="btn secondary btn-compact"
                                onClick={close}
                                aria-label="Close reading options"
                            >
                                <X size={15} aria-hidden="true" />
                            </button>
                        </header>
                        <div className="reading-options-inline">
                            <VoiceSettings
                                compact
                                backendReady={modelReady}
                                activeVoiceId={activeVoiceId}
                                onVoiceChange={onVoiceChange}
                            />
                            <label className="reading-option-field reading-options-lang">
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
                        </div>
                        {!isTextBook ? (
                            <div className="reading-option-field reading-options-span">
                                <button
                                    type="button"
                                    className="btn secondary btn-compact"
                                    onClick={onForceOcr}
                                    disabled={disabled}
                                >
                                    <ScanText size={15} aria-hidden="true" /> {isOcring ? 'Running OCR…' : 'Re-run OCR'}
                                </button>
                            </div>
                        ) : null}
                    </section>

                </>
            ) : null}
        </div>
    );
}
