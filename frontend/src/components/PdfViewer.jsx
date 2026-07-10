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
import {
    estimateWordTimings,
    estimateWordTimingsFromSegments,
    wordIndexAtTime,
} from '../utils/timings';
import {
    buildWordSpanMap,
    applyWordHighlight,
    clearPdfHighlights,
} from '../utils/pdfHighlight';
import { useToast } from './Toast';
import { useTtsStatus } from '../hooks/useTtsStatus';
import { useUserConfig } from '../hooks/useUserConfig';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import VoiceSettings from './VoiceSettings';
import Transcript from './Transcript';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export default function PdfViewer({ onDirty }) {
    const toast = useToast();
    const [isGenerating, setIsGenerating] = useState(false);
    const { modelReady, modelError, modelStatusDetail, deviceInfo, retryLoad } =
        useTtsStatus({ pollWhileGenerating: isGenerating });
    const { config, updateConfig } = useUserConfig();

    const [file, setFile] = useState(null);
    const [numPages, setNumPages] = useState(null);
    const [pageNumber, setPageNumber] = useState(1);
    const [isPlaying, setIsPlaying] = useState(false);
    const [audioUrl, setAudioUrl] = useState(null);
    const [audioPage, setAudioPage] = useState(null);
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
    const [voiceSwitchHint, setVoiceSwitchHint] = useState('');

    const audioRef = useRef(null);
    const containerRef = useRef(null);
    const pdfDocRef = useRef(null);
    const fileRef = useRef(null);
    const wordSpanMapRef = useRef([]);
    const prevHighlightSpanRef = useRef(null);
    const pageWordsRef = useRef([]);
    const wordTimesRef = useRef([]);
    const langRef = useRef(targetLanguage);
    const pageTextRef = useRef('');
    const audioPageRef = useRef(null);
    const audioVoiceRef = useRef(null);
    const isPlayingRef = useRef(false);
    const currentWordRef = useRef(-1);
    const voiceSwitchGenRef = useRef(0);
    const segmentsRef = useRef([]);
    const rafRef = useRef(0);

    langRef.current = targetLanguage;
    pageTextRef.current = pageText;
    audioPageRef.current = audioPage;
    isPlayingRef.current = isPlaying;
    currentWordRef.current = currentWord;

    // Apply saved user settings once, when config arrives — but never clobber
    // a choice the user already made while config was still loading.
    const configAppliedRef = useRef(false);
    const userTouchedRef = useRef({ voice: false, language: false });
    useEffect(() => {
        if (config && !configAppliedRef.current) {
            configAppliedRef.current = true;
            if (!userTouchedRef.current.voice && config.voice_id) {
                setActiveVoiceId(config.voice_id);
                audioVoiceRef.current = config.voice_id;
            }
            if (!userTouchedRef.current.language && config.language_id) {
                setTargetLanguage(config.language_id);
            }
        }
    }, [config]);

    const clearPlaybackState = useCallback(() => {
        setIsPlaying(false);
        isPlayingRef.current = false;
        setCurrentWord(-1);
        currentWordRef.current = -1;
        clearPdfHighlights(containerRef.current || document);
        prevHighlightSpanRef.current = null;
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
        }
    }, []);

    const pauseAudio = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.pause();
        }
        setIsPlaying(false);
        isPlayingRef.current = false;
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
        }
    }, []);

    const goToPage = (next) => {
        if (next === pageNumber) return;
        pauseAudio();
        setCurrentWord(-1);
        clearPdfHighlights(containerRef.current || document);
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
            const availH = Math.max(280, el.clientHeight - padY - 8);
            const pageAspect = 1 / 1.414;
            const widthFromHeight = availH * pageAspect;
            const fit = Math.floor(Math.min(availW, widthFromHeight, 900));
            setPageWidth(Math.max(240, fit));
        };

        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [file, numPages]);

    const extractTextFromPage = async (pdf, pageNum) => {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
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

    const applyTimings = useCallback(
        (text, segments, duration) => {
            const { words, times } = estimateWordTimingsFromSegments(
                text,
                segments,
                langRef.current,
                duration
            );
            if (!words.length) {
                const fallbackWords = text.split(/\s+/).filter(Boolean);
                const fallbackTimes = estimateWordTimings(
                    fallbackWords,
                    duration,
                    langRef.current
                );
                setPageWords(fallbackWords);
                setWordStartTimes(fallbackTimes);
                pageWordsRef.current = fallbackWords;
                wordTimesRef.current = fallbackTimes;
            } else {
                setPageWords(words);
                setWordStartTimes(times);
                pageWordsRef.current = words;
                wordTimesRef.current = times;
            }
            requestAnimationFrame(() => rebindWordSpans());
        },
        [rebindWordSpans]
    );

    const syncHighlightAt = useCallback((currentTime) => {
        const idx = wordIndexAtTime(wordTimesRef.current, currentTime);
        if (idx !== currentWordRef.current) {
            currentWordRef.current = idx;
            setCurrentWord(idx);
        }
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
    }, []);

    const startHighlightLoop = useCallback(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        const tick = () => {
            const audio = audioRef.current;
            if (!audio || audio.paused || audio.ended) {
                rafRef.current = 0;
                return;
            }
            syncHighlightAt(audio.currentTime);
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
    }, [syncHighlightAt]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const handleLoadedMetadata = () => {
            if (pageTextRef.current) {
                applyTimings(
                    pageTextRef.current,
                    segmentsRef.current,
                    audio.duration || 0
                );
            }
        };

        const handlePlay = () => {
            setIsPlaying(true);
            isPlayingRef.current = true;
            startHighlightLoop();
        };

        const handlePause = () => {
            setIsPlaying(false);
            isPlayingRef.current = false;
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = 0;
            }
            // Keep highlight frozen on the current word while paused.
            if (audio.currentTime != null) {
                syncHighlightAt(audio.currentTime);
            }
        };

        const handleEnded = () => {
            clearPlaybackState();
        };

        // Fallback for browsers that throttle rAF in background tabs.
        const handleTimeUpdate = () => {
            if (!audio.paused) syncHighlightAt(audio.currentTime);
        };

        audio.addEventListener('loadedmetadata', handleLoadedMetadata);
        audio.addEventListener('play', handlePlay);
        audio.addEventListener('pause', handlePause);
        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('timeupdate', handleTimeUpdate);
        return () => {
            audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
            audio.removeEventListener('play', handlePlay);
            audio.removeEventListener('pause', handlePause);
            audio.removeEventListener('ended', handleEnded);
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [applyTimings, clearPlaybackState, startHighlightLoop, syncHighlightAt]);

    const onPageRenderSuccess = useCallback(() => {
        requestAnimationFrame(() => rebindWordSpans());
    }, [rebindWordSpans]);

    /**
     * Generate narration for the current page text.
     * @param {{ resumeWordIndex?: number, autoplay?: boolean, voiceId?: string|null }} opts
     */
    const generateAudio = useCallback(
        async (pageNum, text, opts = {}) => {
            const {
                resumeWordIndex = 0,
                autoplay = true,
                voiceId = activeVoiceId,
            } = opts;

            setIsGenerating(true);
            setVoiceSwitchHint(
                resumeWordIndex > 0
                    ? 'Switching voice — picking up where you left off…'
                    : ''
            );
            try {
                const result = await narrateText(
                    text,
                    sessionId,
                    pageNum,
                    voiceId,
                    langRef.current
                );
                segmentsRef.current = result.segments || [];
                setAudioUrl(result.audioUrl);
                setAudioPage(pageNum);
                audioPageRef.current = pageNum;
                audioVoiceRef.current = voiceId ?? null;

                const audio = audioRef.current;
                if (audio) {
                    audio.src = result.audioUrl;
                    // Wait for metadata so we can place timings + seek accurately.
                    await new Promise((resolve) => {
                        const onMeta = () => {
                            audio.removeEventListener('loadedmetadata', onMeta);
                            resolve();
                        };
                        if (audio.readyState >= 1) resolve();
                        else audio.addEventListener('loadedmetadata', onMeta);
                    });

                    applyTimings(
                        text,
                        segmentsRef.current,
                        audio.duration || result.duration_s || 0
                    );

                    const times = wordTimesRef.current;
                    const seekIdx = Math.max(
                        0,
                        Math.min(resumeWordIndex, Math.max(0, times.length - 1))
                    );
                    const seekTime = times[seekIdx] ?? 0;
                    try {
                        audio.currentTime = seekTime;
                    } catch {
                        /* ignore seek race */
                    }
                    setCurrentWord(seekIdx);
                    currentWordRef.current = seekIdx;
                    syncHighlightAt(seekTime);

                    if (autoplay) {
                        await audio.play().catch(() => {});
                        setIsPlaying(true);
                        isPlayingRef.current = true;
                        startHighlightLoop();
                    } else {
                        setIsPlaying(false);
                        isPlayingRef.current = false;
                    }
                }
                onDirty?.();
            } catch (error) {
                toast.error('Failed to narrate: ' + error.message);
                throw error;
            } finally {
                setIsGenerating(false);
                setVoiceSwitchHint('');
            }
        },
        [
            activeVoiceId,
            applyTimings,
            onDirty,
            sessionId,
            startHighlightLoop,
            syncHighlightAt,
            toast,
        ]
    );

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
        pageTextRef.current = text;
        setPageWords([]);
        setWordStartTimes([]);
        pageWordsRef.current = [];
        wordTimesRef.current = [];
        wordSpanMapRef.current = [];
        segmentsRef.current = [];
        setCurrentWord(-1);
        return text;
    };

    /**
     * Speechify-style voice change: regenerate with the new voice and resume
     * at the same word whether playback was running or paused.
     */
    const switchVoiceLive = useCallback(
        async (nextVoiceId) => {
            const text = pageTextRef.current;
            const page = pageNumber;
            if (!text || !modelReady) return;
            // Only seamless-switch when we already have narration for this page
            // (or are mid-read). Fresh voice picks without audio just stick.
            const hasPageAudio = audioPageRef.current === page && !!audioRef.current?.src;
            if (!hasPageAudio && !isPlayingRef.current) {
                audioVoiceRef.current = nextVoiceId;
                return;
            }

            const gen = ++voiceSwitchGenRef.current;
            const wasPlaying = isPlayingRef.current;
            const resumeWord = Math.max(0, currentWordRef.current);

            pauseAudio();
            setVoiceSwitchHint('Loading new voice…');

            try {
                await generateAudio(page, text, {
                    resumeWordIndex: resumeWord,
                    autoplay: wasPlaying,
                    voiceId: nextVoiceId,
                });
                if (gen !== voiceSwitchGenRef.current) return; // superseded
            } catch {
                /* toast already shown */
            }
        },
        [generateAudio, modelReady, pageNumber, pauseAudio]
    );

    const handleVoiceChange = useCallback(
        (id) => {
            userTouchedRef.current.voice = true;
            setActiveVoiceId(id);
            updateConfig({ voice_id: id }).catch((e) =>
                toast.error(e?.message || 'Could not save voice preference')
            );
            // Fire-and-forget seamless switch (latest generation wins).
            switchVoiceLive(id);
        },
        [switchVoiceLive, toast, updateConfig]
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

    const handlePlay = async () => {
        if (!file || !numPages) return;

        if (isPlaying) {
            audioRef.current?.pause();
            setIsPlaying(false);
            isPlayingRef.current = false;
            return;
        }

        if (audioUrl && audioPage === pageNumber) {
            audioRef.current?.play();
            setIsPlaying(true);
            isPlayingRef.current = true;
            startHighlightLoop();
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
            await generateAudio(pageNumber, text, {
                resumeWordIndex: 0,
                autoplay: true,
                voiceId: activeVoiceId,
            });
        } catch (error) {
            toast.error(error.message);
        }
    };

    const handleResume = () => {
        setShowResumeChoice(false);
        if (audioRef.current) {
            audioRef.current.play();
            setIsPlaying(true);
            isPlayingRef.current = true;
            startHighlightLoop();
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
            await generateAudio(pageNumber, text, {
                resumeWordIndex: 0,
                autoplay: true,
                voiceId: activeVoiceId,
            });
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
                await generateAudio(pageNumber, text, {
                    resumeWordIndex: 0,
                    autoplay: true,
                    voiceId: activeVoiceId,
                });
            }
        } catch (error) {
            toast.error(error.message);
        }
    };

    const handleSeek = (time) => {
        if (audioRef.current) {
            audioRef.current.currentTime = time;
            syncHighlightAt(time);
            if (!isPlaying) {
                audioRef.current.play();
                setIsPlaying(true);
                isPlayingRef.current = true;
                startHighlightLoop();
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
        audioPageRef.current = null;
        setPageText('');
        pageTextRef.current = '';
        setPageWords([]);
        setWordStartTimes([]);
        pageWordsRef.current = [];
        wordTimesRef.current = [];
        wordSpanMapRef.current = [];
        segmentsRef.current = [];
        audioVoiceRef.current = null;
        clearPlaybackState();
        onDirty?.();
    };

    const getPlayButtonState = () => {
        if (modelError) return { text: 'AI model error', disabled: true, icon: null };
        if (!modelReady)
            return {
                text: 'Warming up…',
                disabled: true,
                icon: <Loader2 className="spinner" size={16} />,
            };
        if (isOcring)
            return {
                text: ' OCR…',
                disabled: true,
                icon: <Loader2 className="spinner" size={16} />,
            };
        if (isGenerating)
            return {
                text: voiceSwitchHint
                    ? ` ${voiceSwitchHint}`
                    : modelStatusDetail?.startsWith('Generating')
                      ? ` ${modelStatusDetail}`
                      : ' Generating…',
                disabled: true,
                icon: <Loader2 className="spinner" size={16} />,
            };
        if (isPlaying)
            return { text: ' Pause', disabled: false, icon: <Pause size={16} /> };
        if (audioUrl && audioPage === pageNumber)
            return { text: ' Resume', disabled: false, icon: <Play size={16} /> };
        return {
            text: ' Read page ' + pageNumber,
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
                    <div className="pdf-toolbar">
                        <div className="pdf-toolbar-voice">
                            <VoiceSettings
                                activeVoiceId={activeVoiceId}
                                onVoiceChange={handleVoiceChange}
                            />
                        </div>
                        <div className="pdf-toolbar-controls">
                            <div className="lang-select-group">
                                <Languages size={15} />
                                <select
                                    id="pdf-lang"
                                    value={targetLanguage}
                                    onChange={(e) => handleLanguageChange(e.target.value)}
                                    disabled={isGenerating || isOcring}
                                    aria-label="Narration language"
                                >
                                    {SUPPORTED_LANGUAGES.map((lang) => (
                                        <option key={lang.code} value={lang.code}>
                                            {lang.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <button
                                className="btn secondary btn-compact"
                                onClick={handleForceOcr}
                                disabled={isGenerating || isOcring}
                                title="Use OCR for scanned pages"
                            >
                                {isOcring ? (
                                    <Loader2 className="spinner" size={15} />
                                ) : (
                                    <ScanText size={15} />
                                )}
                                <span>OCR</span>
                            </button>
                            <button
                                className="btn secondary btn-compact"
                                onClick={() => goToPage(Math.max(1, pageNumber - 1))}
                                disabled={pageNumber === 1}
                            >
                                <ChevronUp size={15} />
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
                                className="btn secondary btn-compact"
                                onClick={() =>
                                    goToPage(Math.min(numPages, pageNumber + 1))
                                }
                                disabled={pageNumber === numPages}
                            >
                                <ChevronDown size={15} />
                            </button>
                            <span className="pdf-page-indicator">
                                {pageNumber}/{numPages}
                            </span>
                        </div>
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
                            <button className="btn secondary" onClick={retryLoad}>
                                Retry
                            </button>
                        </div>
                    )}
                    {deviceInfo === 'cpu' && modelReady && (
                        <div className="model-loading-status-bar error">
                            <span>
                                TTS is on CPU (very slow). Run fix_cuda_torch.bat so your
                                RTX GPU is used.
                            </span>
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
                                voiceId={activeVoiceId}
                                languageId={targetLanguage}
                                onSeek={handleSeek}
                                statusHint={
                                    voiceSwitchHint ||
                                    (isGenerating
                                        ? 'Generating narration…'
                                        : undefined)
                                }
                            />
                        </div>
                    </div>
                </>
            )}
            <audio ref={audioRef} style={{ display: 'none' }} preload="auto" />
        </div>
    );
}
