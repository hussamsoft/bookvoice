import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { Loader2, Play, Pause, ChevronUp, ChevronDown, X, Languages, ScanText } from 'lucide-react';
import { narrateText } from '../utils/api';
import { extractTextFromImage } from '../utils/ocr';
import { cleanExtractedText } from '../utils/cleanup';
import { createSessionId } from '../utils/session';
import { SUPPORTED_LANGUAGES } from '../utils/languages';
import { useToast } from './Toast';
import { useTtsStatus } from '../hooks/useTtsStatus';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import VoiceSettings from './VoiceSettings';
import Transcript from './Transcript';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export default function PdfViewer({ onDirty }) {
    const toast = useToast();
    const { modelReady, modelError, modelStatusDetail } = useTtsStatus();

    const [file, setFile] = useState(null);
    const [numPages, setNumPages] = useState(null);
    const [pageNumber, setPageNumber] = useState(1);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentSentenceIndex, setCurrentSentenceIndex] = useState(-1);
    const [sentences, setSentences] = useState([]);
    const [audioUrl, setAudioUrl] = useState(null);
    const [audioPage, setAudioPage] = useState(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [isOcring, setIsOcring] = useState(false);
    const [activeVoiceId, setActiveVoiceId] = useState(null);
    const [targetLanguage, setTargetLanguage] = useState('en');
    const [showResumeChoice, setShowResumeChoice] = useState(false);
    const [pageText, setPageText] = useState('');
    const [pageWords, setPageWords] = useState([]);
    const [wordStartTimes, setWordStartTimes] = useState([]);
    const [currentWord, setCurrentWord] = useState(-1);
    const [sessionId] = useState(() => createSessionId('pdf'));

    const audioRef = useRef(null);
    const containerRef = useRef(null);
    const pdfDocRef = useRef(null);
    const fileRef = useRef(null);

    const chunkText = (text) => {
        const parts = text.match(/[^.!?؟]+[.!?؟]+/g);
        return parts && parts.length ? parts : [text];
    };

    const clearPlaybackState = useCallback(() => {
        setIsPlaying(false);
        setCurrentSentenceIndex(-1);
        setCurrentWord(-1);
        const textLayer = document.querySelector('.react-pdf__Page__textContent');
        if (textLayer) {
            textLayer.querySelectorAll('.highlight-active').forEach((span) => {
                span.classList.remove('highlight-active');
            });
        }
    }, []);

    const pauseAudio = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.pause();
        }
        clearPlaybackState();
    }, [clearPlaybackState]);

    // Pause and clear highlights when changing pages
    const goToPage = (next) => {
        if (next === pageNumber) return;
        pauseAudio();
        setPageNumber(next);
    };

    const extractTextFromPage = async (pdf, pageNum) => {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const textItems = textContent.items.map((item) => item.str);
        return textItems.join(' ').replace(/\s+/g, ' ').trim();
    };

    /** Render a PDF page to a JPEG data URL for OCR (scanned books). */
    const renderPageToDataUrl = async (pdf, pageNum, scale = 2) => {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        return canvas.toDataURL('image/jpeg', 0.92);
    };

    const getPdfDocument = async () => {
        if (pdfDocRef.current) return pdfDocRef.current;
        const f = fileRef.current || file;
        if (!f) throw new Error('No PDF loaded');
        const arrayBuffer = await f.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        pdfDocRef.current = pdf;
        return pdf;
    };

    const computeWordTimings = useCallback((text, duration) => {
        const words = text.split(/\s+/).filter(Boolean);
        if (!words.length || !duration) return;
        setPageWords(words);
        const totalChars = words.reduce((sum, w) => sum + w.length, 0) || 1;
        let cumulative = 0;
        const times = words.map((w) => {
            const start = cumulative;
            cumulative += (w.length / totalChars) * duration;
            return start;
        });
        setWordStartTimes(times);
    }, []);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || pageWords.length === 0) return;

        const handleTimeUpdate = () => {
            const duration = audio.duration;
            const currentTime = audio.currentTime;
            if (!duration) return;

            const totalChars = sentences.join('').length;
            if (sentences.length > 0 && totalChars > 0) {
                let charAcc = 0;
                const progressRatio = currentTime / duration;
                const targetChar = progressRatio * totalChars;
                let foundIndex = 0;
                for (let i = 0; i < sentences.length; i++) {
                    charAcc += sentences[i].length;
                    if (charAcc >= targetChar) {
                        foundIndex = i;
                        break;
                    }
                }
                setCurrentSentenceIndex(foundIndex);

                const textLayer = document.querySelector('.react-pdf__Page__textContent');
                if (textLayer && sentences[foundIndex]) {
                    const spans = Array.from(textLayer.querySelectorAll('span'));
                    const words = sentences[foundIndex]
                        .split(/\s+/)
                        .filter((w) => w.length > 3);
                    spans.forEach((span) => {
                        span.classList.remove('highlight-active');
                        if (words.some((w) => span.textContent.includes(w))) {
                            span.classList.add('highlight-active');
                        }
                    });
                }
            }

            let idx = -1;
            for (let i = wordStartTimes.length - 1; i >= 0; i--) {
                if (currentTime >= wordStartTimes[i]) {
                    idx = i;
                    break;
                }
            }
            setCurrentWord(idx);
        };

        const handleLoadedMetadata = () => {
            if (pageText) {
                computeWordTimings(pageText, audio.duration);
            }
        };

        const handleEnded = () => {
            clearPlaybackState();
        };

        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('loadedmetadata', handleLoadedMetadata);
        audio.addEventListener('ended', handleEnded);
        return () => {
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
            audio.removeEventListener('ended', handleEnded);
        };
    }, [
        sentences,
        pageWords,
        wordStartTimes,
        pageText,
        computeWordTimings,
        clearPlaybackState,
    ]);

    const generateAudio = async (pageNum, text) => {
        setIsGenerating(true);
        try {
            const url = await narrateText(
                text,
                sessionId,
                pageNum,
                activeVoiceId,
                targetLanguage
            );
            setAudioUrl(url);
            setAudioPage(pageNum);
            if (audioRef.current) {
                audioRef.current.src = url;
                await audioRef.current.play().catch(() => {});
            }
            setIsPlaying(true);
            setCurrentSentenceIndex(0);
            setCurrentWord(0);
            onDirty?.();
        } catch (error) {
            toast.error('Failed to narrate: ' + error.message);
        } finally {
            setIsGenerating(false);
        }
    };

    const preparePageText = async (pageNum, { forceOcr = false } = {}) => {
        const pdf = await getPdfDocument();
        let text = '';

        if (!forceOcr) {
            text = await extractTextFromPage(pdf, pageNum);
        }

        if (!text.trim() || forceOcr) {
            setIsOcring(true);
            try {
                toast.info(
                    forceOcr
                        ? 'Running OCR on this page…'
                        : 'No embedded text — running OCR on page image…'
                );
                const dataUrl = await renderPageToDataUrl(pdf, pageNum);
                const raw = await extractTextFromImage(dataUrl);
                text = cleanExtractedText(raw);
            } finally {
                setIsOcring(false);
            }
        }

        if (!text.trim()) {
            throw new Error(
                'No text found on this page. Try OCR again or check page quality.'
            );
        }

        setPageText(text);
        setSentences(chunkText(text));
        setPageWords([]);
        setWordStartTimes([]);
        setCurrentWord(-1);
        return text;
    };

    const handlePlay = async () => {
        if (!file || !numPages) return;

        if (isPlaying) {
            audioRef.current?.pause();
            setIsPlaying(false);
            return;
        }

        if (audioUrl && audioPage === pageNumber) {
            audioRef.current?.play();
            setIsPlaying(true);
            return;
        }

        if (audioUrl && audioPage !== pageNumber) {
            setShowResumeChoice(true);
            return;
        }

        if (!modelReady) {
            toast.error(modelError || 'AI voice model is still loading.');
            return;
        }

        try {
            const text = await preparePageText(pageNumber);
            await generateAudio(pageNumber, text);
        } catch (error) {
            toast.error(error.message);
        }
    };

    const handleResume = () => {
        setShowResumeChoice(false);
        if (audioRef.current) {
            audioRef.current.play();
            setIsPlaying(true);
        }
    };

    const handleReadNewPage = async () => {
        setShowResumeChoice(false);
        if (!modelReady) {
            toast.error(modelError || 'AI voice model is still loading.');
            return;
        }
        try {
            const text = await preparePageText(pageNumber);
            await generateAudio(pageNumber, text);
        } catch (error) {
            toast.error(error.message);
        }
    };

    const handleForceOcr = async () => {
        if (!file) return;
        try {
            const text = await preparePageText(pageNumber, { forceOcr: true });
            toast.success(`OCR extracted ${text.split(/\s+/).length} words`);
            if (modelReady) {
                await generateAudio(pageNumber, text);
            }
        } catch (error) {
            toast.error(error.message);
        }
    };

    const handleSeek = (time) => {
        if (audioRef.current) {
            audioRef.current.currentTime = time;
            if (!isPlaying) {
                audioRef.current.play();
                setIsPlaying(true);
            }
        }
    };

    const handleFileChange = (e) => {
        const f = e.target.files[0];
        if (!f) return;
        setFile(f);
        fileRef.current = f;
        pdfDocRef.current = null;
        setNumPages(null);
        setPageNumber(1);
        setAudioUrl(null);
        setAudioPage(null);
        setPageText('');
        setSentences([]);
        setPageWords([]);
        setWordStartTimes([]);
        clearPlaybackState();
        onDirty?.();
    };

    const visiblePages = [];
    if (numPages) {
        visiblePages.push(pageNumber);
        if (pageNumber + 1 <= numPages) visiblePages.push(pageNumber + 1);
        if (pageNumber + 2 <= numPages) visiblePages.push(pageNumber + 2);
    }

    const getPlayButtonState = () => {
        if (modelError) return { text: 'AI model error', disabled: true, icon: null };
        if (!modelReady)
            return {
                text: 'Warming up AI voices…',
                disabled: true,
                icon: <Loader2 className="spinner" size={16} />,
            };
        if (isOcring)
            return {
                text: ' Running OCR…',
                disabled: true,
                icon: <Loader2 className="spinner" size={16} />,
            };
        if (isGenerating)
            return {
                text: ' Generating…',
                disabled: true,
                icon: <Loader2 className="spinner" size={16} />,
            };
        if (isPlaying)
            return { text: ' Pause', disabled: false, icon: <Pause size={16} /> };
        if (audioUrl && audioPage === pageNumber)
            return { text: ' Resume', disabled: false, icon: <Play size={16} /> };
        if (audioUrl && audioPage !== pageNumber)
            return {
                text: ' Read Page ' + pageNumber,
                disabled: false,
                icon: <Play size={16} />,
            };
        return {
            text: ' Read Page ' + pageNumber,
            disabled: false,
            icon: <Play size={16} />,
        };
    };

    const playBtn = getPlayButtonState();

    return (
        <div className="pdf-viewer-container">
            {!file ? (
                <div className="upload-state pdf-upload-state">
                    <input
                        type="file"
                        accept=".pdf,application/pdf"
                        onChange={handleFileChange}
                        id="pdf-upload"
                        className="file-input"
                    />
                    <label htmlFor="pdf-upload" className="btn primary">
                        Select PDF Book
                    </label>
                </div>
            ) : (
                <>
                    <div className="voice-settings-bar">
                        <VoiceSettings
                            activeVoiceId={activeVoiceId}
                            onVoiceChange={setActiveVoiceId}
                        />
                    </div>

                    <div className="pdf-lang-bar">
                        <div className="lang-select-group">
                            <Languages size={16} />
                            <label htmlFor="pdf-lang">Narration language</label>
                            <select
                                id="pdf-lang"
                                value={targetLanguage}
                                onChange={(e) => setTargetLanguage(e.target.value)}
                                disabled={isGenerating || isOcring}
                            >
                                {SUPPORTED_LANGUAGES.map((lang) => (
                                    <option key={lang.code} value={lang.code}>
                                        {lang.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <button
                            className="btn secondary"
                            onClick={handleForceOcr}
                            disabled={isGenerating || isOcring}
                            title="Use OCR for scanned pages without a text layer"
                        >
                            {isOcring ? (
                                <>
                                    <Loader2 className="spinner" size={16} /> OCR…
                                </>
                            ) : (
                                <>
                                    <ScanText size={16} /> OCR this page
                                </>
                            )}
                        </button>
                    </div>

                    <div className="pdf-controls-bar">
                        <button
                            className="btn secondary"
                            onClick={() => goToPage(Math.max(1, pageNumber - 1))}
                            disabled={pageNumber === 1}
                        >
                            <ChevronUp size={16} /> Prev
                        </button>
                        <button
                            className="btn primary"
                            onClick={handlePlay}
                            disabled={playBtn.disabled}
                        >
                            {playBtn.icon}
                            {playBtn.text}
                        </button>
                        <button
                            className="btn secondary"
                            onClick={() => goToPage(Math.min(numPages, pageNumber + 1))}
                            disabled={pageNumber === numPages}
                        >
                            Next <ChevronDown size={16} />
                        </button>
                        <span className="pdf-page-indicator">
                            Page {pageNumber} of {numPages}
                        </span>
                    </div>

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

                    {showResumeChoice && (
                        <div
                            className="resume-modal-overlay"
                            onClick={() => setShowResumeChoice(false)}
                        >
                            <div
                                className="resume-modal"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <button
                                    className="resume-modal-close"
                                    onClick={() => setShowResumeChoice(false)}
                                >
                                    <X size={18} />
                                </button>
                                <h3>Resume or start new?</h3>
                                <p>
                                    You have audio for <strong>Page {audioPage}</strong>.
                                </p>
                                <div className="resume-modal-actions">
                                    <button className="btn secondary" onClick={handleResume}>
                                        Resume Page {audioPage}
                                    </button>
                                    <button className="btn primary" onClick={handleReadNewPage}>
                                        Read Page {pageNumber}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="pdf-layout">
                        <div className="pdf-main">
                            <div className="pdf-scroll-area" ref={containerRef}>
                                <Document
                                    file={file}
                                    onLoadSuccess={({ numPages: n }) => setNumPages(n)}
                                    loading={
                                        <div className="pdf-loading">
                                            <Loader2 className="spinner" size={40} />
                                        </div>
                                    }
                                >
                                    {visiblePages.map((page) => (
                                        <div key={page} className="pdf-page-wrapper">
                                            <Page
                                                pageNumber={page}
                                                width={800}
                                                renderAnnotationLayer={false}
                                            />
                                        </div>
                                    ))}
                                </Document>
                            </div>
                        </div>
                        <div className="pdf-transcript">
                            <Transcript
                                words={pageWords}
                                wordStartTimes={wordStartTimes}
                                currentWord={currentWord}
                                isPlaying={isPlaying}
                                isPaused={!!audioUrl && !isPlaying && !isGenerating}
                                sessionId={sessionId}
                                pageIndex={pageNumber}
                                voiceId={activeVoiceId}
                                languageId={targetLanguage}
                                onSeek={handleSeek}
                                audioRef={audioRef}
                            />
                        </div>
                    </div>
                </>
            )}
            <audio ref={audioRef} style={{ display: 'none' }} />
        </div>
    );
}
