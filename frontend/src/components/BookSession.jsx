import React, { useState } from 'react';
import CameraCapture from './CameraCapture';
import TextEditor from './TextEditor';
import AudioPlayer from './AudioPlayer';
import VoiceSettings from './VoiceSettings';
import { extractTextFromImage } from '../utils/ocr';
import { cleanExtractedText } from '../utils/cleanup';
import { narrateText } from '../utils/api';
import { createSessionId } from '../utils/session';
import { useToast } from './Toast';
import { useTtsStatus } from '../hooks/useTtsStatus';
import { Loader2 } from 'lucide-react';

const STEPS = ['capture', 'processing', 'review', 'playback'];

export default function BookSession({ onDirty }) {
    const toast = useToast();
    const { modelReady, modelError, modelStatusDetail } = useTtsStatus();
    const [sessionId] = useState(() => createSessionId('session'));
    const [pages, setPages] = useState([]);
    const [currentPageIndex, setCurrentPageIndex] = useState(0);
    const [step, setStep] = useState('capture');
    const [currentText, setCurrentText] = useState('');
    const [activeVoiceId, setActiveVoiceId] = useState(null);
    const [targetLanguage, setTargetLanguage] = useState('en');

    const handleCapture = async (imageDataUrl) => {
        setStep('processing');
        try {
            const rawText = await extractTextFromImage(imageDataUrl);
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
            console.error(error);
            toast.error('Failed to process image: ' + error.message);
            setStep('capture');
        }
    };

    const handleNarrate = async (text) => {
        if (!modelReady) {
            toast.error(modelError || 'AI voice model is still loading. Please wait.');
            return;
        }
        try {
            const audioUrl = await narrateText(
                text,
                sessionId,
                currentPageIndex,
                activeVoiceId,
                targetLanguage
            );

            setPages((prev) => {
                const updated = [...prev];
                updated[currentPageIndex] = { text, audioUrl };
                return updated;
            });
            setStep('playback');
            onDirty?.();
            toast.success('Narration ready');
        } catch (error) {
            console.error('TTS Generation Error:', error);
            toast.error(error.message || 'Failed to generate audio.');
            setStep('review');
        }
    };

    const handleNextPage = () => {
        setCurrentPageIndex(pages.length);
        setCurrentText('');
        setStep('capture');
    };

    const stepIndex = STEPS.indexOf(step);

    return (
        <div className="book-session">
            <header className="session-header">
                <div className="header-top">
                    <h2>Reading Session</h2>
                    <div className="page-indicator">Page {currentPageIndex + 1}</div>
                </div>

                <div className="step-indicator" aria-hidden="true">
                    {STEPS.slice(0, 3).map((s, i) => (
                        <div
                            key={s}
                            className={`step-dot ${i < stepIndex ? 'done' : ''} ${
                                i === stepIndex ? 'active' : ''
                            }`}
                        />
                    ))}
                </div>

                <VoiceSettings activeVoiceId={activeVoiceId} onVoiceChange={setActiveVoiceId} />

                {!modelReady && modelStatusDetail && (
                    <div className="model-loading-status-bar">
                        <Loader2 className="spinner" size={14} />
                        <span>{modelStatusDetail}</span>
                    </div>
                )}
                {modelError && (
                    <div className="model-loading-status-bar error">
                        <span>Error: {modelError}</span>
                    </div>
                )}
            </header>

            <div className="session-content">
                {step === 'capture' && <CameraCapture onCapture={handleCapture} />}

                {step === 'processing' && (
                    <div className="loading-state">
                        <Loader2 className="spinner" size={40} />
                        <p>Extracting text from page...</p>
                    </div>
                )}

                {step === 'review' && (
                    <TextEditor
                        key={`review-${currentPageIndex}-${sessionId}`}
                        initialText={currentText}
                        targetLanguage={targetLanguage}
                        onTranslateChange={setTargetLanguage}
                        onNarrate={handleNarrate}
                        onRetake={() => setStep('capture')}
                    />
                )}

                {step === 'playback' && pages[currentPageIndex] && (
                    <AudioPlayer
                        audioUrl={pages[currentPageIndex].audioUrl}
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
                                    onClick={() => {
                                        setCurrentPageIndex(i);
                                        setStep('playback');
                                    }}
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
