import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronDown, Download, ScanText, SlidersHorizontal, X } from 'lucide-react';
import VoiceSettings from '../VoiceSettings';
import { SUPPORTED_LANGUAGES } from '../../utils/languages';

/**
 * Reading options with a self-managed trigger: anchored popover at >=1024px,
 * bottom sheet below. Voice + language stay inline; "Whole book" actions
 * (prepare, export) collapse into a single "Book actions" dropdown.
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
    const [bookActionsOpen, setBookActionsOpen] = useState(false);
    const rootRef = useRef(null);
    const triggerRef = useRef(null);
    const panelRef = useRef(null);
    const bookActionsRef = useRef(null);
    const bookActionsOpenRef = useRef(false);
    useEffect(() => {
        bookActionsOpenRef.current = bookActionsOpen;
    }, [bookActionsOpen]);

    const close = useCallback(() => {
        setOpen(false);
        triggerRef.current?.focus();
    }, []);

    const closeBookActions = useCallback(() => {
        setBookActionsOpen(false);
    }, []);

    // Initial focus: only when panel opens, not on every bookActionsOpen toggle.
    useEffect(() => {
        if (!open) return;
        panelRef.current?.querySelector('button, select, input')?.focus();
    }, [open]);

    useEffect(() => {
        if (!open) return undefined;

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                if (bookActionsOpenRef.current) {
                    closeBookActions();
                } else {
                    close();
                }
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
            if (bookActionsRef.current && !bookActionsRef.current.contains(event.target)) {
                closeBookActions();
                return;
            }
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
    }, [open, close, closeBookActions]);



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
                        <div className="reading-option-field reading-options-span book-actions" ref={bookActionsRef}>
                            <button
                                type="button"
                                className="btn secondary btn-compact book-actions-trigger"
                                onClick={() => setBookActionsOpen((value) => !value)}
                                aria-expanded={bookActionsOpen}
                                aria-haspopup="true"
                            >
                                <BookOpen size={15} aria-hidden="true" /> Book actions
                                <ChevronDown size={14} aria-hidden="true" className={`book-actions-chevron ${bookActionsOpen ? 'open' : ''}`} />
                            </button>
                            {bookActionsOpen ? (
                                <div className="book-actions-menu" role="menu" aria-label="Book actions">
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className="btn primary btn-compact"
                                        onClick={() => {
                                            onPrepareWholeBook();
                                            closeBookActions();
                                        }}
                                        disabled={!canPrepareBook || preparationRunning}
                                    >
                                        Prepare whole book
                                    </button>
                                    {hasProfile ? (
                                        <>
                                            <button
                                                type="button"
                                                role="menuitem"
                                                className="btn secondary btn-compact"
                                                onClick={() => {
                                                    onCreatePreparedFile();
                                                    closeBookActions();
                                                }}
                                            >
                                                <Download size={15} aria-hidden="true" /> Save .bookvoice file
                                            </button>
                                            {isExportingAudiobook ? (
                                                <button
                                                    type="button"
                                                    role="menuitem"
                                                    className="btn secondary btn-compact"
                                                    onClick={() => {
                                                        onCancelExportAudiobook();
                                                        closeBookActions();
                                                    }}
                                                >
                                                    {audiobookProgress
                                                        ? `Cancel export (${audiobookProgress.pagesDone}/${audiobookProgress.pageCount})`
                                                        : 'Cancel export'}
                                                </button>
                                            ) : (
                                                <button
                                                    type="button"
                                                    role="menuitem"
                                                    className="btn secondary btn-compact"
                                                    onClick={() => {
                                                        onExportAudiobook();
                                                        closeBookActions();
                                                    }}
                                                >
                                                    Export audiobook
                                                </button>
                                            )}
                                        </>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                    </section>

                </>
            ) : null}
        </div>
    );
}
