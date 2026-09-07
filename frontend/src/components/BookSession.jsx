import { useCallback, useEffect, useRef, useState } from 'react';
import CameraCapture from './CameraCapture';
import TextEditor from './TextEditor';
import NarrationPlayback from './NarrationPlayback';
import VoiceSettings from './VoiceSettings';
import { extractTextFromImage } from '../utils/ocr';
import { cleanExtractedText } from '../utils/cleanup';
import { importPreparedBook, narrateText } from '../utils/api';
import { createSessionId } from '../utils/session';
import { useToast } from './Toast';
import { useTtsStatus } from '../hooks/useTtsStatus';
import { useUserConfig } from '../hooks/useUserConfig';
import StatusBanner from './ui/StatusBanner';
import Button from './ui/Button';
import { FolderPlus, Loader2 } from 'lucide-react';

const STEPS = ['capture', 'processing', 'review', 'playback'];
const STEP_LABELS = {
    capture: 'Capture a page',
    processing: 'Reading the page',
    review: 'Review the text',
    playback: 'Listen',
};

export default function BookSession({ epoch, onDirty, onOpenBook }) {
    const toast = useToast();
    const [isNarratingUi, setIsNarratingUi] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const { modelReady, modelError, modelStatusDetail, deviceInfo, retryLoad } =
        useTtsStatus({ pollWhileGenerating: isNarratingUi });
    const { config, updateConfig } = useUserConfig();
    const [sessionId] = useState(() => createSessionId('session'));
    const [pages, setPages] = useState([]);
    const [currentPageIndex, setCurrentPageIndex] = useState(0);
    const [step, setStep] = useState('capture');
    const [currentText, setCurrentText] = useState('');
    const [activeVoiceId, setActiveVoiceId] = useState(null);
    const [targetLanguage, setTargetLanguage] = useState('en');
    const epochRef = useRef(epoch);
    useEffect(() => { epochRef.current = epoch; }, [epoch]);


    // Apply saved user settings once, when config arrives — but never clobber
    // a choice the user already made while config was still loading.
    const configAppliedRef = useRef(false);
    const userTouchedRef = useRef({ voice: false, language: false });
    useEffect(() => {
        if (config && !configAppliedRef.current) {
            configAppliedRef.current = true;
            if (!userTouchedRef.current.voice && config.voice_id) {
                setActiveVoiceId(config.voice_id);
            }
            if (!userTouchedRef.current.language && config.language_id) {
                setTargetLanguage(config.language_id);
            }
        }
    }, [config]);

    const handleVoiceChange = useCallback(
        (id) => {
            userTouchedRef.current.voice = true;
            setActiveVoiceId(id);
            updateConfig({ voice_id: id }).catch((e) =>
                toast.error(e?.message || 'Could not save voice preference')
            );
        },
        [toast, updateConfig]
    );

    const handleLanguageChange = useCallback(
        (lang) => {
            userTouchedRef.current.language = true;
            setTargetLanguage(lang);
            updateConfig({ language_id: lang }).catch((e) =>
                toast.error(e?.message || 'Could not save language preference')
            );
        },
        [toast, updateConfig]
    );
    const handleCapture = async (imageDataUrl) => {
        const startEpoch = epochRef.current;
        setStep('processing');
        try {
            const rawText = await extractTextFromImage(imageDataUrl);
            if (epochRef.current !== startEpoch) return;
            const cleaned = cleanExtractedText(rawText);

            if (!cleaned.trim()) {
                toast.error('No text found on this page. Try better lighting or focus.');
                setStep('capture');
                return;
            }

            setCurrentText(cleaned);
            setStep('review');
            onDirty?.();
        } catch (error) {
            if (epochRef.current !== startEpoch) return;
            toast.error('Failed to process image: ' + error.message);
            setStep('capture');
        }

    };

    const handleNarrate = async (text) => {
        if (!modelReady) {
            toast.error(modelError || 'Voice model is still loading. Please wait.');
            return;
        }
        const startEpoch = epochRef.current;
        setIsNarratingUi(true);
        try {
            const result = await narrateText(
                text,
                sessionId,
                currentPageIndex,
                activeVoiceId,
                targetLanguage
            );

            if (epochRef.current !== startEpoch) return;

            setPages((prev) => {
                const updated = [...prev];
                updated[currentPageIndex] = {
                    text,
                    audioUrl: result.audioUrl,
                    segments: result.segments,
                    duration_s: result.duration_s,
                    word_timings: result.word_timings,
                };
                return updated;
            });
            setStep('playback');
            onDirty?.();
            toast.success('Narration ready');
        } catch (error) {
            if (epochRef.current !== startEpoch) return;
            toast.error(error.message || 'Failed to generate audio.');
            setStep('review');
        } finally {

            setIsNarratingUi(false);
        }
    };

    /** Keep the page as text only — narration can happen later from the Library. */
    const handleSaveText = (text) => {
        if (!text.trim()) return;
        const isNewPage = currentPageIndex >= pages.length;
        setPages((prev) => {
            const updated = [...prev];
            updated[currentPageIndex] = { text };
            return updated;
        });
        toast.success(`Page ${currentPageIndex + 1} text saved.`);
        if (isNewPage) {
            setCurrentPageIndex(currentPageIndex + 1);
            setCurrentText('');
            setStep('capture');
        }
    };

    const handleNextPage = () => {
        setCurrentPageIndex(Math.max(pages.length, currentPageIndex + 1));
        setCurrentText('');
        setStep('capture');
    };

    /** Turn the whole session into a real Library book (.txt import). */
    const handleSaveToLibrary = async () => {
        const text = pages.map((page) => page?.text || '').join('\n\n').trim();
        if (!text) return;
        setIsSaving(true);
        try {
            const title = `Scanned pages ${new Date().toISOString().slice(0, 10)}`;
            const file = new File([text], `${title}.txt`, { type: 'text/plain' });
            const book = await importPreparedBook(file);
            toast.success('Saved to your Library.');
            onOpenBook?.(book);
        } catch (error) {
            toast.error(error.message || 'Could not save these pages to the Library.');
        } finally {
            setIsSaving(false);
        }
    };

    const stepIndex = STEPS.indexOf(step);
    const currentPage = pages[currentPageIndex] || null;

    // Free navigation: a step is reachable when its content exists. The
    // processing step is transient and never a click target.
    const stepReachable = (stepName) => {
        if (stepName === 'capture') return true;
        if (stepName === 'review') return Boolean(currentText || currentPage);
        if (stepName === 'playback') return Boolean(currentPage?.audioUrl);
        return false;
    };

    const openHistoryPage = (index) => {
        setCurrentPageIndex(index);
        setCurrentText(pages[index]?.text || '');
        setStep(pages[index]?.audioUrl ? 'playback' : 'review');
    };

    return (
        <div className="book-session">
            <header className="session-header">
                <div className="header-top">
                    <h2>Scan pages</h2>
                    <div className="header-top-actions">
                        <span className="page-indicator">Page {currentPageIndex + 1}</span>
                        {pages.length > 0 && (
                            <Button
                                variant="primary"
                                size="sm"
                                icon={FolderPlus}
                                onClick={handleSaveToLibrary}
                                disabled={isSaving}
                                title="Turn these pages into a book in your Library"
                            >
                                {isSaving ? 'Saving…' : 'Save to Library'}
                            </Button>
                        )}
                    </div>
                </div>

                <div className="step-tracker" role="group" aria-label="Progress">
                    <span className="sr-only" aria-live="polite">
                        Step {stepIndex + 1} of {STEPS.length}: {STEP_LABELS[STEPS[stepIndex]]}
                    </span>
                    {STEPS.map((stepName, index) => {
                        const isActive = index === stepIndex;
                        const isComplete = index < stepIndex;
                        const reachable = stepReachable(stepName);
                        const stepLabel = STEP_LABELS[stepName];
                        const body = (
                            <>
                                <span className="step-dot" aria-hidden="true">
                                    {isComplete ? '✓' : index + 1}
                                </span>
                                <span className="step-label">{stepLabel}</span>
                            </>
                        );
                        return (
                            <div
                                key={stepName}
                                className={`step-track-item ${isActive ? 'active' : ''} ${isComplete ? 'complete' : ''}`}
                            >
                                {reachable && !isActive ? (
                                    <button
                                        type="button"
                                        className="step-track-button"
                                        onClick={() => {
                                            if (stepName === 'review') setCurrentText(currentPage?.text || currentText);
                                            setStep(stepName);
                                        }}
                                    >
                                        {body}
                                    </button>
                                ) : (
                                    <div className="step-track-button" aria-current={isActive ? 'step' : undefined}>
                                        {body}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>


                <VoiceSettings compact backendReady={modelReady} activeVoiceId={activeVoiceId} onVoiceChange={handleVoiceChange} />

                {!modelReady && modelStatusDetail && (
                    <StatusBanner tone="loading" className="compact-banner">
                        <Loader2 className="spinner" size={14} aria-hidden="true" /> {modelStatusDetail}
                    </StatusBanner>
                )}
                {modelError && (
                    <StatusBanner
                        tone="error"
                        className="compact-banner"
                        action={
                            <Button variant="secondary" size="sm" onClick={retryLoad}>
                                Retry
                            </Button>
                        }
                    >
                        Error: {modelError}
                    </StatusBanner>
                )}
                {deviceInfo === 'cpu' && modelReady && (
                    <StatusBanner tone="warning" className="compact-banner">
                        Narration is running on the CPU, so it will be much slower than with a GPU.
                    </StatusBanner>
                )}
            </header>

            <div className="session-content">
                {step === 'capture' && <CameraCapture onCapture={handleCapture} />}

                {step === 'processing' && (
                    <div className="loading-state">
                        <div className="skeleton skeleton--block" aria-hidden="true" />
                        <p>Extracting text from page...</p>
                    </div>
                )}

                {step === 'review' && (
                    <TextEditor
                        key={`review-${currentPageIndex}-${sessionId}`}
                        initialText={currentText || currentPage?.text || ''}
                        targetLanguage={targetLanguage}
                        onTranslateChange={handleLanguageChange}
                        onNarrate={handleNarrate}
                        onSaveText={handleSaveText}
                        onRetake={() => setStep('capture')}
                    />
                )}

                {step === 'playback' && currentPage?.audioUrl && (
                    <NarrationPlayback
                        audioUrl={currentPage.audioUrl}
                        text={currentPage.text}
                        segments={currentPage.segments}
                        duration_s={currentPage.duration_s}
                        word_timings={currentPage.word_timings}
                        languageId={targetLanguage}
                        downloadName={`captured-page-${currentPageIndex + 1}.wav`}
                        onNextPage={handleNextPage}
                    />
                )}
            </div>

            {pages.length > 0 && (
                <div className="history">
                    <h3>Pages in this session</h3>
                    <div className="history-list">
                        {pages.map((p, i) =>
                            p ? (
                                <button
                                    key={i}
                                    className={`history-item ${
                                        i === currentPageIndex ? 'active' : ''
                                    }`}
                                    aria-current={i === currentPageIndex ? 'true' : undefined}
                                    title={p.audioUrl ? 'Narrated page' : 'Text-only page'}
                                    onClick={() => openHistoryPage(i)}
                                >
                                    Page {i + 1}
                                </button>
                            ) : null
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
