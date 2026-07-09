import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import {
    Loader2,
    Play,
    Pause,
    ChevronUp,
    ChevronDown,
    X,
    Languages,
    ScanText,
} from 'lucide-react';
import { narrateText } from '../utils/api';
import { extractTextFromImage } from '../utils/ocr';
import { cleanExtractedText } from '../utils/cleanup';
import { createSessionId } from '../utils/session';
import { SUPPORTED_LANGUAGES } from '../utils/languages';
import { estimateWordTimings, wordIndexAtTime } from '../utils/timings';
import {
    buildWordSpanMap,
    applyWordHighlight,
    clearPdfHighlights,
} from '../utils/pdfHighlight';
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
    const [pageWidth, setPageWidth] = useState(520);
    const [sessionId] = useState(() => createSessionId('pdf'));

    const audioRef = useRef(null);
    const containerRef = useRef(null);
    const pdfDocRef = useRef(null);
    const fileRef = useRef(null);
    const wordSpanMapRef = useRef([]);
    const prevHighlightSpanRef = useRef(null);
    const pageWordsRef = useRef([]);
    const wordTimesRef = useRef([]);
    const langRef = useRef(targetLanguage);

    langRef.current = targetLanguage;

    const clearPlaybackState = useCallback(() => {
        setIsPlaying(false);
        setCurrentWord(-1);
        clearPdfHighlights(containerRef.current || document);
        prevHighlightSpanRef.current = null;
    }, []);

    const pauseAudio = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.pause();
        }
        clearPlaybackState();
    }, [clearPlaybackState]);

    const goToPage = (next) => {
        if (next === pageNumber) return;
        pauseAudio();
        setPageNumber(next);
    };

    // Fit PDF page into the scroll viewport (portrait-friendly)
    useEffect(() => {
        const el = containerRef.current;
        if (!el || !file) return;

        const measure = () => {
            const styles = getComputedStyle(el);
            const padX =
                (parseFloat(styles.paddingLeft) || 0) +
                (parseFloat(styles.paddingRight) || 0);
            const padY =
                (parseFloat(styles.paddingTop) || 0) +
                (parseFloat(styles.paddingBottom) || 0);
            const availW = Math.max(240, el.clientWidth - padX - 8);
            const availH = Math.max(320, el.clientHeight - padY - 8);
            // Typical book / letter portrait ≈ 1 : 1.414 (ISO A)
            const pageAspect = 1 / 1.414;
            const widthFromHeight = availH * pageAspect;
            const fit = Math.floor(Math.min(availW, widthFromHeight, 860));
            setPageWidth(Math.max(260, fit));
        };

        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [file, numPages]);

    const extractTextFromPage = async (pdf, pageNum) => {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        // Preserve reading order with slight y-sorting for multi-column edge cases
        const items = textContent.items
            .filter((item) => item.str != null)
            .map((item) => {
                const t = item.transform || [1, 0, 0, 1, 0, 0];
                return { str: item.str, x: t[4], y: t[5] };
            });
        items.sort((a, b) => {
            const dy = b.y - a.y;
            if (Math.abs(dy) > 4) return dy;
            return a.x - b.x;
        });
        return items
            .map((i) => i.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    };

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

    const rebindWordSpans = useCallback(() => {
        const textLayer = containerRef.current?.querySelector(
            '.react-pdf__Page__textContent'
        );
        if (!textLayer || !pageWordsRef.current.length) {
            wordSpanMapRef.current = [];
            return;
        }
        wordSpanMapRef.current = buildWordSpanMap(pageWordsRef.current, textLayer);
    }, []);

    const computeWordTimings = useCallback((text, duration) => {
        const words = text.split(/\s+/).filter(Boolean);
        if (!words.length || !duration) return;
        const times = estimateWordTimings(words, duration, langRef.current);
        setPageWords(words);
        setWordStartTimes(times);
        pageWordsRef.current = words;
        wordTimesRef.current = times;
        // Re-align after text layer paints
        requestAnimationFrame(() => rebindWordSpans());
    }, [rebindWordSpans]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const handleTimeUpdate = () => {
            const duration = audio.duration;
            const currentTime = audio.currentTime;
            if (!duration) return;

            const idx = wordIndexAtTime(wordTimesRef.current, currentTime);
            setCurrentWord(idx);

            const textLayer = containerRef.current?.querySelector(
                '.react-pdf__Page__textContent'
            );
            if (textLayer && wordSpanMapRef.current.length) {
                applyWordHighlight(
                    textLayer,
                    wordSpanMapRef.current,
                    idx,
                    prevHighlightSpanRef
                );
            }
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
    }, [pageText, computeWordTimings, clearPlaybackState]);

    // Rebuild span map when the visible page finishes rendering
    const onPageRenderSuccess = useCallback(() => {
        requestAnimationFrame(() => rebindWordSpans());
    }, [rebindWordSpans]);

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
        setPageWords([]);
        setWordStartTimes([]);
        pageWordsRef.current = [];
        wordTimesRef.current = [];
        wordSpanMapRef.current = [];
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
        setPageWords([]);
        setWordStartTimes([]);
        pageWordsRef.current = [];
        wordTimesRef.current = [];
        wordSpanMapRef.current = [];
        clearPlaybackState();
        onDirty?.();
    };

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
                    <p className="pdf-upload-hint">
                        Text PDFs read instantly. Scanned pages use OCR automatically.
                    </p>
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
                                    <div className="pdf-page-wrapper pdf-page-current">
                                        <Page
                                            pageNumber={pageNumber}
                                            width={pageWidth}
                                            renderAnnotationLayer={false}
                                            renderTextLayer={true}
                                            onRenderSuccess={onPageRenderSuccess}
                                            className="pdf-page-fit"
                                        />
                                    </div>
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
                            />
                        </div>
                    </div>
                </>
            )}
            <audio ref={audioRef} style={{ display: 'none' }} />
        </div>
    );
}
