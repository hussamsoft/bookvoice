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
    ZoomIn,
    ZoomOut,
    Maximize2,
} from 'lucide-react';
import { narrateText } from '../utils/api';
import { extractTextFromImage } from '../utils/ocr';
import { cleanExtractedText } from '../utils/cleanup';
import { createSessionId } from '../utils/session';
import { SUPPORTED_LANGUAGES } from '../utils/languages';
import {
    estimateWordTimings,
    estimateWordTimingsFromSegments,
    stitchPartialTimings,
    wordIndexAtTime,
} from '../utils/timings';
import { detectSpeechOnset, shiftTimingsToOnset } from '../utils/audioOnset';
import { createPageAudioCache, cacheKey } from '../utils/pageAudioCache';
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

const PREFETCH_RADIUS = 2;
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 2.6;
const ZOOM_STEP = 0.15;

function cleanPronounceWord(word) {
    return String(word || '')
        .replace(/[^\w\s'\u0600-\u06FF-]/g, '')
        .trim();
}

export default function PdfViewer({ onDirty }) {
    const toast = useToast();
    const [isGenerating, setIsGenerating] = useState(false);
    const isGeneratingRef = useRef(false);
    const { modelReady, modelError, modelStatusDetail, deviceInfo, retryLoad } =
        useTtsStatus({ pollWhileGenerating: isGenerating });
    const { config, updateConfig } = useUserConfig();

    const [file, setFile] = useState(null);
    const [numPages, setNumPages] = useState(null);
    const [pageNumber, setPageNumber] = useState(1);
    const [pageJumpInput, setPageJumpInput] = useState('1');
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
    const [basePageWidth, setBasePageWidth] = useState(520);
    const [zoom, setZoom] = useState(1);
    const [statusHint, setStatusHint] = useState('');
    const [sessionId] = useState(() => createSessionId('pdf'));
    const [prefetchHint, setPrefetchHint] = useState('');

    const audioRef = useRef(null);
    const pronounceRef = useRef(null);
    const containerRef = useRef(null);
    const pdfDocRef = useRef(null);
    const fileRef = useRef(null);
    const wordSpanMapRef = useRef([]);
    const prevHighlightSpanRef = useRef(null);
    const pageWordsRef = useRef([]);
    const wordTimesRef = useRef([]);
    const langRef = useRef(targetLanguage);
    const pageTextRef = useRef('');
    const pageNumberRef = useRef(1);
    const audioPageRef = useRef(null);
    const audioVoiceRef = useRef(null);
    const isPlayingRef = useRef(false);
    const currentWordRef = useRef(-1);
    const voiceSwitchGenRef = useRef(0);
    const segmentsRef = useRef([]);
    const rafRef = useRef(0);
    const cacheRef = useRef(createPageAudioCache({ maxEntries: 14 }));
    const textCacheRef = useRef(new Map()); // page -> text
    const prefetchBusyRef = useRef(false);
    const prefetchQueueRef = useRef([]);
    const activeVoiceRef = useRef(null);
    const panDragRef = useRef(null);

    langRef.current = targetLanguage;
    pageTextRef.current = pageText;
    pageNumberRef.current = pageNumber;
    audioPageRef.current = audioPage;
    isPlayingRef.current = isPlaying;
    currentWordRef.current = currentWord;
    activeVoiceRef.current = activeVoiceId;
    isGeneratingRef.current = isGenerating;

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

    useEffect(() => {
        setPageJumpInput(String(pageNumber));
    }, [pageNumber]);

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
        if (audioRef.current) audioRef.current.pause();
        setIsPlaying(false);
        isPlayingRef.current = false;
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
        }
    }, []);

    // Fit base page width into the scroll viewport
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
            setBasePageWidth(Math.max(240, fit));
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [file, numPages]);

    const displayWidth = Math.round(basePageWidth * zoom);

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

    const applyWordState = useCallback(
        (words, times) => {
            setPageWords(words);
            setWordStartTimes(times);
            pageWordsRef.current = words;
            wordTimesRef.current = times;
            requestAnimationFrame(() => rebindWordSpans());
        },
        [rebindWordSpans]
    );

    const buildTimings = useCallback(async (text, segments, duration, audioUrlForOnset) => {
        let { words, times } = estimateWordTimingsFromSegments(
            text,
            segments,
            langRef.current,
            duration
        );
        if (!words.length) {
            words = text.split(/\s+/).filter(Boolean);
            times = estimateWordTimings(words, duration, langRef.current);
        }
        if (audioUrlForOnset && times.length) {
            const onset = await detectSpeechOnset(audioUrlForOnset);
            if (onset > 0.01) {
                times = shiftTimingsToOnset(times, onset, duration || Infinity);
            }
        }
        return { words, times };
    }, []);

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
            if (audio.currentTime != null) syncHighlightAt(audio.currentTime);
        };
        const handleEnded = () => {
            // Soft end: leave resume on last word
            setIsPlaying(false);
            isPlayingRef.current = false;
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = 0;
            }
            const last = Math.max(0, pageWordsRef.current.length - 1);
            setCurrentWord(last);
            currentWordRef.current = last;
        };
        const handleTimeUpdate = () => {
            if (!audio.paused) syncHighlightAt(audio.currentTime);
        };

        audio.addEventListener('play', handlePlay);
        audio.addEventListener('pause', handlePause);
        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('timeupdate', handleTimeUpdate);
        return () => {
            audio.removeEventListener('play', handlePlay);
            audio.removeEventListener('pause', handlePause);
            audio.removeEventListener('ended', handleEnded);
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [startHighlightLoop, syncHighlightAt]);

    const onPageRenderSuccess = useCallback(() => {
        requestAnimationFrame(() => rebindWordSpans());
    }, [rebindWordSpans]);

    const preparePageText = useCallback(
        async (pageNum, { forceOcr = false, quiet = false } = {}) => {
            if (!forceOcr && textCacheRef.current.has(pageNum)) {
                return textCacheRef.current.get(pageNum);
            }
            const pdf = await getPdfDocument();
            let text = '';
            if (!forceOcr) {
                text = await extractTextFromPage(pdf, pageNum);
            }
            if (!text.trim() || forceOcr) {
                if (!quiet) setIsOcring(true);
                try {
                    if (!quiet) {
                        toast.info(
                            forceOcr
                                ? 'Running OCR on this page…'
                                : 'No embedded text — running OCR…'
                        );
                    }
                    const dataUrl = await renderPageToDataUrl(pdf, pageNum);
                    const raw = await extractTextFromImage(dataUrl);
                    text = cleanExtractedText(raw);
                } finally {
                    if (!quiet) setIsOcring(false);
                }
            }
            if (!text.trim()) {
                throw new Error('No text found on this page.');
            }
            textCacheRef.current.set(pageNum, text);
            return text;
        },
        // file is read via fileRef / getPdfDocument; toast is stable enough for UI notes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [toast]
    );

    const waitAudioReady = (audio) =>
        new Promise((resolve) => {
            if (audio.readyState >= 1) {
                resolve();
                return;
            }
            const onMeta = () => {
                audio.removeEventListener('loadedmetadata', onMeta);
                resolve();
            };
            audio.addEventListener('loadedmetadata', onMeta);
        });

    /**
     * Apply a ready cache entry (or fresh result) to the main player.
     */
    const applyReadyAudio = useCallback(
        async (entry, { autoplay, resumeWordIndex = 0 }) => {
            const audio = audioRef.current;
            if (!audio || !entry?.audioUrl) return;

            segmentsRef.current = entry.segments || [];
            setAudioUrl(entry.audioUrl);
            setAudioPage(entry.page);
            audioPageRef.current = entry.page;
            audioVoiceRef.current = entry.voiceId ?? null;
            setPageText(entry.text);
            pageTextRef.current = entry.text;

            audio.src = entry.audioUrl;
            await waitAudioReady(audio);

            let words = entry.words;
            let times = entry.times;
            if (!words?.length || !times?.length) {
                const built = await buildTimings(
                    entry.text,
                    entry.segments,
                    audio.duration || entry.duration_s || 0,
                    entry.audioUrl
                );
                words = built.words;
                times = built.times;
                entry.words = words;
                entry.times = times;
            }
            applyWordState(words, times);

            // For partial clips, resumeWordIndex is a page word with audio time 0.
            // For full clips, seek to that word's absolute time.
            const seekIdx = Math.max(
                0,
                Math.min(resumeWordIndex, Math.max(0, times.length - 1))
            );
            let seekTime = times[seekIdx] ?? 0;
            if (seekTime < 0) seekTime = 0;
            // If this entry is a partial starting at seekIdx, audio begins at 0.
            if (entry.partial && entry.fromWord === seekIdx) {
                seekTime = 0;
            }
            try {
                audio.currentTime = seekTime;
            } catch {
                /* ignore */
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
        },
        [applyWordState, buildTimings, startHighlightLoop, syncHighlightAt]
    );

    /**
     * Narrate a page (or partial remaining text for fast voice switch).
     * Stores full-page ready entries in the cache.
     */
    const narratePage = useCallback(
        async (pageNum, text, opts = {}) => {
            const {
                voiceId = activeVoiceRef.current,
                languageId = langRef.current,
                fromWord = 0,
                storeFullCache = true,
            } = opts;

            const words = text.split(/\s+/).filter(Boolean);
            const start = Math.max(0, Math.min(fromWord, Math.max(0, words.length - 1)));
            const partial = start > 0;
            const narrateBody = partial ? words.slice(start).join(' ') : text;
            // Unique page_index for partials so we don't clobber full-page wav.
            const storageIndex = partial ? pageNum * 100000 + start : pageNum;

            const result = await narrateText(
                narrateBody,
                sessionId,
                storageIndex,
                voiceId,
                languageId
            );

            const duration = result.duration_s || 0;
            let built = await buildTimings(
                narrateBody,
                result.segments,
                duration,
                result.audioUrl
            );

            // For partials, stitch into full-page word arrays for UI continuity.
            let fullWords = words;
            let fullTimes = built.times;
            if (partial) {
                fullTimes = stitchPartialTimings(words, start, built.times);
                built = { words: fullWords, times: fullTimes };
            }

            const entry = {
                status: 'ready',
                page: pageNum,
                voiceId: voiceId ?? null,
                languageId,
                text,
                audioUrl: result.audioUrl,
                segments: result.segments || [],
                duration_s: duration,
                words: built.words,
                times: built.times,
                fromWord: start,
                partial,
            };

            // Only full-page narrations go into the flip cache (partials are
            // voice-switch resume clips and shouldn't satisfy "page ready").
            if (storeFullCache && !partial) {
                cacheRef.current.set(cacheKey(pageNum, voiceId, languageId), entry);
            }
            return entry;
        },
        [buildTimings, sessionId]
    );

    const generateAndPlay = useCallback(
        async (pageNum, text, opts = {}) => {
            const {
                resumeWordIndex = 0,
                autoplay = true,
                voiceId = activeVoiceRef.current,
                force = false,
                partialFromResume = false,
            } = opts;

            const key = cacheKey(pageNum, voiceId, langRef.current);
            if (!force && !partialFromResume && cacheRef.current.hasReady(key)) {
                const hit = cacheRef.current.get(key);
                await applyReadyAudio(hit, { autoplay, resumeWordIndex });
                return hit;
            }

            setIsGenerating(true);
            isGeneratingRef.current = true;
            try {
                const fromWord = partialFromResume ? resumeWordIndex : 0;
                const entry = await narratePage(pageNum, text, {
                    voiceId,
                    fromWord,
                    storeFullCache: !partialFromResume,
                });
                // Partial clips start at audio t=0 == page word `fromWord`.
                // stitchPartialTimings uses -1 sentinels for earlier words.
                await applyReadyAudio(entry, {
                    autoplay,
                    resumeWordIndex,
                });
                onDirty?.();
                return entry;
            } catch (error) {
                toast.error(error.message || 'Failed to narrate');
                throw error;
            } finally {
                setIsGenerating(false);
                isGeneratingRef.current = false;
                setStatusHint('');
            }
        },
        [applyReadyAudio, narratePage, onDirty, toast]
    );

    // -------- Prefetch queue (single-file TTS; never starve UI) --------
    const runPrefetchQueue = useCallback(async () => {
        if (prefetchBusyRef.current) return;
        prefetchBusyRef.current = true;
        try {
            while (prefetchQueueRef.current.length) {
                // Yield the single TTS worker while the user is generating.
                if (isGeneratingRef.current) {
                    await new Promise((r) => setTimeout(r, 350));
                    continue;
                }
                const job = prefetchQueueRef.current.shift();
                if (!job) break;
                const { page, voiceId, languageId } = job;
                const key = cacheKey(page, voiceId, languageId);
                if (cacheRef.current.hasReady(key)) continue;
                try {
                    setPrefetchHint(`Warming page ${page}…`);
                    const text = await preparePageText(page, { quiet: true });
                    if (isGeneratingRef.current) {
                        // User started a narrate; put job back and yield.
                        prefetchQueueRef.current.unshift(job);
                        await new Promise((r) => setTimeout(r, 350));
                        continue;
                    }
                    await narratePage(page, text, {
                        voiceId,
                        languageId,
                        fromWord: 0,
                        storeFullCache: true,
                    });
                } catch {
                    /* prefetch is best-effort */
                }
            }
        } finally {
            prefetchBusyRef.current = false;
            setPrefetchHint('');
        }
    }, [narratePage, preparePageText]);

    const schedulePrefetch = useCallback(
        (centerPage, total) => {
            if (!modelReady || !total) return;
            const voiceId = activeVoiceRef.current;
            const languageId = langRef.current;
            const lo = Math.max(1, centerPage - PREFETCH_RADIUS);
            const hi = Math.min(total, centerPage + PREFETCH_RADIUS);
            cacheRef.current.retainPageWindow(lo, hi);

            // Priority: next pages first, then previous (reading direction).
            const order = [];
            for (let d = 1; d <= PREFETCH_RADIUS; d++) {
                if (centerPage + d <= total) order.push(centerPage + d);
            }
            for (let d = 1; d <= PREFETCH_RADIUS; d++) {
                if (centerPage - d >= 1) order.push(centerPage - d);
            }

            const q = [];
            for (const p of order) {
                const key = cacheKey(p, voiceId, languageId);
                if (!cacheRef.current.hasReady(key)) {
                    q.push({ page: p, voiceId, languageId });
                }
            }
            prefetchQueueRef.current = q;
            // Defer so current narrate can finish first.
            setTimeout(() => runPrefetchQueue(), 400);
        },
        [modelReady, runPrefetchQueue]
    );

    const loadPageIntoView = useCallback(
        async (pageNum, { autoplay = false } = {}) => {
            pauseAudio();
            setPageNumber(pageNum);
            pageNumberRef.current = pageNum;

            try {
                const text = await preparePageText(pageNum);
                setPageText(text);
                pageTextRef.current = text;
                setPageWords(text.split(/\s+/).filter(Boolean));
                pageWordsRef.current = text.split(/\s+/).filter(Boolean);

                const key = cacheKey(pageNum, activeVoiceRef.current, langRef.current);
                if (cacheRef.current.hasReady(key)) {
                    await applyReadyAudio(cacheRef.current.get(key), {
                        autoplay,
                        resumeWordIndex: 0,
                    });
                } else {
                    setAudioUrl(null);
                    setAudioPage(null);
                    audioPageRef.current = null;
                    setWordStartTimes([]);
                    wordTimesRef.current = [];
                    setCurrentWord(-1);
                    if (autoplay && modelReady) {
                        await generateAndPlay(pageNum, text, {
                            autoplay: true,
                            resumeWordIndex: 0,
                        });
                    }
                }
                if (numPages) schedulePrefetch(pageNum, numPages);
            } catch (e) {
                toast.error(e.message);
            }
        },
        [
            applyReadyAudio,
            generateAndPlay,
            modelReady,
            numPages,
            pauseAudio,
            preparePageText,
            schedulePrefetch,
            toast,
        ]
    );

    const goToPage = (next) => {
        if (!numPages) return;
        const n = Math.max(1, Math.min(numPages, next));
        if (n === pageNumber) return;
        loadPageIntoView(n, { autoplay: false });
    };

    const handlePageJump = (e) => {
        e?.preventDefault?.();
        const n = parseInt(pageJumpInput, 10);
        if (!Number.isFinite(n)) {
            setPageJumpInput(String(pageNumber));
            return;
        }
        goToPage(n);
    };

    const switchVoiceLive = useCallback(
        async (nextVoiceId) => {
            const text = pageTextRef.current;
            const page = pageNumberRef.current;
            if (!text || !modelReady) {
                audioVoiceRef.current = nextVoiceId;
                return;
            }
            const hasPageAudio =
                audioPageRef.current === page && !!audioRef.current?.src;
            if (!hasPageAudio && !isPlayingRef.current) {
                audioVoiceRef.current = nextVoiceId;
                return;
            }

            const gen = ++voiceSwitchGenRef.current;
            const wasPlaying = isPlayingRef.current;
            const resumeWord = Math.max(0, currentWordRef.current);
            const key = cacheKey(page, nextVoiceId, langRef.current);

            pauseAudio();

            // Instant path: already narrated this page in the target voice.
            if (cacheRef.current.hasReady(key)) {
                setStatusHint('Switching voice…');
                try {
                    await applyReadyAudio(cacheRef.current.get(key), {
                        autoplay: wasPlaying,
                        resumeWordIndex: resumeWord,
                    });
                } finally {
                    if (gen === voiceSwitchGenRef.current) setStatusHint('');
                }
                return;
            }

            // Fast path: only regenerate from the current word to the end.
            setStatusHint('Switching voice — continuing from here…');
            try {
                await generateAndPlay(page, text, {
                    resumeWordIndex: resumeWord,
                    autoplay: wasPlaying,
                    voiceId: nextVoiceId,
                    force: true,
                    partialFromResume: resumeWord > 0,
                });
                if (gen !== voiceSwitchGenRef.current) return;
            } catch {
                /* toasted */
            } finally {
                if (gen === voiceSwitchGenRef.current) setStatusHint('');
            }
        },
        [applyReadyAudio, generateAndPlay, modelReady, pauseAudio]
    );

    const handleVoiceChange = useCallback(
        (id) => {
            userTouchedRef.current.voice = true;
            setActiveVoiceId(id);
            updateConfig({ voice_id: id }).catch((e) =>
                toast.error(e?.message || 'Could not save voice preference')
            );
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
            pauseAudio();
            return;
        }

        // Resume existing audio for this page
        if (audioUrl && audioPage === pageNumber && audioRef.current?.src) {
            await audioRef.current.play().catch(() => {});
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
            setPageText(text);
            pageTextRef.current = text;
            await generateAndPlay(pageNumber, text, {
                autoplay: true,
                resumeWordIndex: Math.max(0, currentWordRef.current),
            });
            schedulePrefetch(pageNumber, numPages);
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
        await loadPageIntoView(pageNumber, { autoplay: true });
    };

    const handleForceOcr = async () => {
        if (!file) return;
        try {
            textCacheRef.current.delete(pageNumber);
            const text = await preparePageText(pageNumber, { forceOcr: true });
            setPageText(text);
            pageTextRef.current = text;
            toast.success(`OCR extracted ${text.split(/\s+/).length} words`);
            if (modelReady) {
                await generateAndPlay(pageNumber, text, {
                    autoplay: true,
                    force: true,
                });
            }
        } catch (error) {
            toast.error(error.message);
        }
    };

    const setResumePoint = useCallback(
        (index) => {
            const times = wordTimesRef.current;
            const idx = Math.max(0, Math.min(index, Math.max(0, times.length - 1)));
            setCurrentWord(idx);
            currentWordRef.current = idx;
            const t = times[idx] ?? 0;
            if (audioRef.current && audioPageRef.current === pageNumberRef.current) {
                try {
                    audioRef.current.currentTime = t;
                } catch {
                    /* ignore */
                }
            }
            syncHighlightAt(t);
        },
        [syncHighlightAt]
    );

    const pronounceWord = useCallback(
        async (word) => {
            const clean = cleanPronounceWord(word);
            if (!clean) return;
            if (!modelReady) {
                toast.error('Voice model is still loading.');
                return;
            }
            const { audioUrl: url } = await narrateText(
                clean,
                sessionId,
                900000 + Math.floor(Math.random() * 1000),
                activeVoiceRef.current,
                langRef.current
            );
            const el = pronounceRef.current;
            if (!el) return;
            el.src = url;
            await el.play().catch(() => {});
        },
        [modelReady, sessionId, toast]
    );

    /**
     * Word click contract:
     *  - playing → seek main audio, keep playing
     *  - paused  → pronounce only + set resume point (do NOT autoplay)
     *  - idle    → pronounce only (+ set resume if we have timings)
     */
    const handleWordActivate = useCallback(
        async (index, word, { isPlaying: playing, isPaused: paused }) => {
            if (playing) {
                const t = wordTimesRef.current[index];
                if (typeof t === 'number' && audioRef.current) {
                    audioRef.current.currentTime = t;
                    syncHighlightAt(t);
                }
                return;
            }

            // Paused or idle: set resume point first so Play continues here.
            if (wordTimesRef.current.length) {
                setResumePoint(index);
            } else {
                setCurrentWord(index);
                currentWordRef.current = index;
            }

            try {
                await pronounceWord(word);
            } catch (e) {
                toast.error(e.message || 'Could not pronounce word');
            }
        },
        [pronounceWord, setResumePoint, syncHighlightAt, toast]
    );

    const handleFileChange = (e) => {
        const f = e.target.files[0];
        if (!f) return;
        setFile(f);
        fileRef.current = f;
        pdfDocRef.current = null;
        setNumPages(null);
        setPageNumber(1);
        pageNumberRef.current = 1;
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
        textCacheRef.current.clear();
        cacheRef.current.clear();
        prefetchQueueRef.current = [];
        audioVoiceRef.current = null;
        setZoom(1);
        clearPlaybackState();
        onDirty?.();
    };

    // Pan via drag when zoomed
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const onDown = (ev) => {
            if (zoom <= 1.02) return;
            if (ev.button !== 0) return;
            panDragRef.current = {
                x: ev.clientX,
                y: ev.clientY,
                sl: el.scrollLeft,
                st: el.scrollTop,
            };
            el.classList.add('is-panning');
        };
        const onMove = (ev) => {
            const d = panDragRef.current;
            if (!d) return;
            el.scrollLeft = d.sl - (ev.clientX - d.x);
            el.scrollTop = d.st - (ev.clientY - d.y);
        };
        const onUp = () => {
            panDragRef.current = null;
            el.classList.remove('is-panning');
        };
        el.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            el.removeEventListener('mousedown', onDown);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [zoom, file]);

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
                text: statusHint ? ` ${statusHint}` : ' Generating…',
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
                        Text PDFs read instantly. Nearby pages warm in the background for
                        seamless flipping.
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

                            <form className="page-jump" onSubmit={handlePageJump}>
                                <label htmlFor="page-jump-input">Page</label>
                                <input
                                    id="page-jump-input"
                                    type="number"
                                    min={1}
                                    max={numPages || 1}
                                    value={pageJumpInput}
                                    onChange={(e) => setPageJumpInput(e.target.value)}
                                    onBlur={handlePageJump}
                                />
                                <span className="page-jump-total">/ {numPages || '—'}</span>
                            </form>

                            <div className="zoom-controls" title="Zoom & pan (drag when zoomed)">
                                <button
                                    type="button"
                                    className="btn secondary btn-compact"
                                    onClick={() =>
                                        setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))
                                    }
                                    aria-label="Zoom out"
                                >
                                    <ZoomOut size={15} />
                                </button>
                                <span className="zoom-label">{Math.round(zoom * 100)}%</span>
                                <button
                                    type="button"
                                    className="btn secondary btn-compact"
                                    onClick={() =>
                                        setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))
                                    }
                                    aria-label="Zoom in"
                                >
                                    <ZoomIn size={15} />
                                </button>
                                <button
                                    type="button"
                                    className="btn secondary btn-compact"
                                    onClick={() => setZoom(1)}
                                    aria-label="Reset zoom"
                                >
                                    <Maximize2 size={15} />
                                </button>
                            </div>

                            <button
                                className="btn secondary btn-compact"
                                onClick={handleForceOcr}
                                disabled={isGenerating || isOcring}
                                title="OCR this page"
                            >
                                {isOcring ? (
                                    <Loader2 className="spinner" size={15} />
                                ) : (
                                    <ScanText size={15} />
                                )}
                            </button>
                            <button
                                className="btn secondary btn-compact"
                                onClick={() => goToPage(pageNumber - 1)}
                                disabled={pageNumber <= 1}
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
                                onClick={() => goToPage(pageNumber + 1)}
                                disabled={pageNumber >= numPages}
                            >
                                <ChevronDown size={15} />
                            </button>
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
                                TTS is on CPU (very slow). Run fix_cuda_torch.bat for GPU.
                            </span>
                        </div>
                    )}
                    {prefetchHint && modelReady && !isGenerating && (
                        <div className="model-loading-status-bar prefetch">
                            <Loader2 className="spinner" size={12} />
                            <span>{prefetchHint}</span>
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
                            <div
                                className={`pdf-scroll-area ${zoom > 1.02 ? 'zoomable' : ''}`}
                                ref={containerRef}
                            >
                                <Document
                                    file={file}
                                    onLoadSuccess={({ numPages: n }) => {
                                        setNumPages(n);
                                        schedulePrefetch(1, n);
                                    }}
                                    loading={
                                        <div className="pdf-loading">
                                            <Loader2 className="spinner" size={40} />
                                        </div>
                                    }
                                >
                                    <div className="pdf-page-wrapper pdf-page-current">
                                        <Page
                                            pageNumber={pageNumber}
                                            width={displayWidth}
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
                                currentWord={currentWord}
                                isPlaying={isPlaying}
                                isPaused={
                                    !!audioUrl &&
                                    audioPage === pageNumber &&
                                    !isPlaying &&
                                    !isGenerating
                                }
                                languageId={targetLanguage}
                                onWordActivate={handleWordActivate}
                                statusHint={
                                    statusHint ||
                                    (isGenerating ? 'Generating narration…' : undefined)
                                }
                            />
                        </div>
                    </div>
                </>
            )}
            <audio ref={audioRef} style={{ display: 'none' }} preload="auto" />
            <audio ref={pronounceRef} style={{ display: 'none' }} preload="auto" />
        </div>
    );
}
