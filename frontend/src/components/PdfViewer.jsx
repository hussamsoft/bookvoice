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
    Bookmark,
    BookmarkCheck,
    Download,
    Search,
} from 'lucide-react';
import { pronounceText, translateText } from '../utils/api';
import { createSessionId } from '../utils/session';
import { SUPPORTED_LANGUAGES } from '../utils/languages';
import { createPageAudioCache, cacheKey } from '../utils/pageAudioCache';
import { clearPdfHighlights } from '../utils/pdfHighlight';
import { useToast } from './Toast';
import { useTtsStatus } from '../hooks/useTtsStatus';
import { useUserConfig } from '../hooks/useUserConfig';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import VoiceSettings from './VoiceSettings';
import Transcript from './Transcript';
import PlaybackControls from './PlaybackControls';
import { useAudioTransport } from '../hooks/useAudioTransport';
import {
    documentFingerprint,
    loadReadingProgress,
    saveReadingProgress,
    toggleBookmark,
} from '../utils/readingProgress';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

import { usePdfDocument } from '../hooks/usePdfDocument';
import { useWordHighlight } from '../hooks/useWordHighlight';
import { usePageNarration } from '../hooks/usePageNarration';
import { usePrefetch } from '../hooks/usePrefetch';
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
    const [currentWord, setCurrentWord] = useState(-1);
    const [basePageWidth, setBasePageWidth] = useState(520);
    const [zoom, setZoom] = useState(1);
    const [displayZoom, setDisplayZoom] = useState(1);
    const zoomDebounceRef = useRef(null);
    const [statusHint, setStatusHint] = useState('');
    const [sessionId] = useState(() => createSessionId('pdf'));
    const [isEditingText, setIsEditingText] = useState(false);
    const [editTextDraft, setEditTextDraft] = useState('');
    const [prefetchHint, setPrefetchHint] = useState('');
    const [documentId, setDocumentId] = useState('');
    const [bookmarks, setBookmarks] = useState([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [isSearching, setIsSearching] = useState(false);

    const audioRef = useRef(null);
    const pronounceRef = useRef(null);
    const containerRef = useRef(null);
    const fileRef = useRef(null);
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
    const cacheRef = useRef(createPageAudioCache({ maxEntries: 14 }));
    const activeVoiceRef = useRef(null);
    const panDragRef = useRef(null);
    const savedResumeRef = useRef({ page: 0, time: 0 });
    const transport = useAudioTransport(audioRef);

    langRef.current = targetLanguage;
    pageTextRef.current = pageText;
    pageNumberRef.current = pageNumber;
    audioPageRef.current = audioPage;
    isPlayingRef.current = isPlaying;
    currentWordRef.current = currentWord;
    activeVoiceRef.current = activeVoiceId;
    isGeneratingRef.current = isGenerating;

    const {
        adoptPdfDocument,
        cachePageText,
        findTextInDocument,
        preparePageText,
        invalidateTextCache,
        resetDocument,
    } = usePdfDocument({ file, fileRef, toast });

    const {
        rebindWordSpans,
        buildTimings,
        syncHighlightAt,
        startHighlightLoop,
        stopHighlightLoop,
        rafRef,
        prevHighlightSpanRef,
    } = useWordHighlight({
        containerRef,
        langRef,
        audioRef,
        setCurrentWord,
        currentWordRef,
        pageWordsRef,
        wordTimesRef,
    });

    const { narratePage } = usePageNarration({
        sessionId,
        activeVoiceRef,
        langRef,
        cacheRef,
        buildTimings,
    });

    const { cancelPrefetch, schedulePrefetch } = usePrefetch({
        cacheRef,
        activeVoiceRef,
        langRef,
        modelReady,
        isGeneratingRef,
        isPlayingRef,
        preparePageText: (page, opts) => preparePageText(page, { ...opts, setIsOcring }),
        narratePage,
        setPrefetchHint,
    });

    const schedulePrefetchSafe = useCallback(
        (centerPage, total) => {
            if (deviceInfo === 'cpu') return;
            schedulePrefetch(centerPage, total);
        },
        [deviceInfo, schedulePrefetch]
    );

    // Debounce zoom display for CSS transform (avoids layout thrash)
    useEffect(() => {
        if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current);
        zoomDebounceRef.current = setTimeout(() => setDisplayZoom(zoom), 80);
        return () => {
            if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current);
        };
    }, [zoom]);

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

    useEffect(() => {
        if (!documentId) return undefined;
        const timer = setTimeout(() => {
            saveReadingProgress(documentId, {
                page: pageNumber,
                time: transport.currentTime,
                zoom,
                playbackRate: transport.playbackRate,
                bookmarks,
            });
        }, 500);
        return () => clearTimeout(timer);
    }, [bookmarks, documentId, pageNumber, transport.currentTime, transport.playbackRate, zoom]);

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
    }, [prevHighlightSpanRef, rafRef]);

    const pauseAudio = useCallback(() => {
        if (audioRef.current) audioRef.current.pause();
        setIsPlaying(false);
        isPlayingRef.current = false;
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
        }
    }, [rafRef]);

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

    const applyWordState = useCallback(
        (words, times) => {
            setPageWords(words);
            pageWordsRef.current = words;
            wordTimesRef.current = times;
            requestAnimationFrame(() => rebindWordSpans());
        },
        [rebindWordSpans]
    );

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

        audio.addEventListener('play', handlePlay);
        audio.addEventListener('pause', handlePause);
        audio.addEventListener('ended', handleEnded);
        return () => {
            audio.removeEventListener('play', handlePlay);
            audio.removeEventListener('pause', handlePause);
            audio.removeEventListener('ended', handleEnded);
            stopHighlightLoop();
        };
    }, [rafRef, startHighlightLoop, stopHighlightLoop, syncHighlightAt]);

    const onPageRenderSuccess = useCallback(() => {
        requestAnimationFrame(() => rebindWordSpans());
    }, [rebindWordSpans]);

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
            if (
                resumeWordIndex === 0 &&
                savedResumeRef.current.page === entry.page &&
                savedResumeRef.current.time > 0
            ) {
                seekTime = Math.min(savedResumeRef.current.time, audio.duration || Infinity);
                savedResumeRef.current = { page: 0, time: 0 };
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

    const loadPageIntoView = useCallback(
        async (pageNum, { autoplay = false } = {}) => {
            cancelPrefetch();
            pauseAudio();
            setPageNumber(pageNum);
            pageNumberRef.current = pageNum;

            try {
                const text = await preparePageText(pageNum, { setIsOcring });
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
                    wordTimesRef.current = [];
                    setCurrentWord(-1);
                    if (autoplay && modelReady) {
                        await generateAndPlay(pageNum, text, {
                            autoplay: true,
                            resumeWordIndex: 0,
                        });
                    }
                }
                if (numPages) schedulePrefetchSafe(pageNum, numPages);
            } catch (e) {
                toast.error(e.message);
            }
        },
        [
            applyReadyAudio,
            cancelPrefetch,
            generateAndPlay,
            modelReady,
            numPages,
            pauseAudio,
            preparePageText,
            schedulePrefetchSafe,
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
            const prevLang = langRef.current;
            setTargetLanguage(lang);
            updateConfig({ language_id: lang }).catch((e) =>
                toast.error(e?.message || 'Could not save language preference')
            );
            if (prevLang !== lang) {
                cacheRef.current.clear();
                setAudioUrl(null);
                setAudioPage(null);
                audioPageRef.current = null;
                pauseAudio();
                toast.info('Language changed — press Read to re-narrate this page.');
            }
        },
        [pauseAudio, toast, updateConfig]
    );

    const handlePlay = async () => {
        cancelPrefetch();
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
            const text = await preparePageText(pageNumber, { setIsOcring });
            setPageText(text);
            pageTextRef.current = text;
            await generateAndPlay(pageNumber, text, {
                autoplay: true,
                resumeWordIndex: Math.max(0, currentWordRef.current),
            });
            schedulePrefetchSafe(pageNumber, numPages);
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
            cachePageText(pageNumber, translated);
            const text = await preparePageText(pageNumber, { forceOcr: true, setIsOcring });
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
            const { audioUrl: url } = await pronounceText(
                clean,
                sessionId,
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
        async (index, word, { isPlaying: playing }) => {
            cancelPrefetch();
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
        [cancelPrefetch, pronounceWord, setResumePoint, syncHighlightAt, toast]
    );

    const handleTranslatePage = async () => {
        const text = pageTextRef.current || pageText;
        if (!text.trim()) return;
        const target = targetLanguage === 'en' ? 'ar' : 'en';
        try {
            setStatusHint('Translating…');
            const translated = await translateText(text, target);
            setPageText(translated);
            pageTextRef.current = translated;
            setPageWords(translated.split(/\s+/).filter(Boolean));
            pageWordsRef.current = translated.split(/\s+/).filter(Boolean);
            invalidateTextCache(pageNumber);
            cacheRef.current.clear();
            setAudioUrl(null);
            toast.success('Text translated — press Read to narrate.');
        } catch (e) {
            toast.error(e.message || 'Translation failed');
        } finally {
            setStatusHint('');
        }
    };

    const handleSaveEditedText = () => {
        const text = editTextDraft.trim();
        if (!text) return;
        setPageText(text);
        pageTextRef.current = text;
        setPageWords(text.split(/\s+/).filter(Boolean));
        pageWordsRef.current = text.split(/\s+/).filter(Boolean);
        cachePageText(pageNumber, text);
        cacheRef.current.clear();
        setAudioUrl(null);
        setIsEditingText(false);
        toast.info('Text updated — press Read to narrate.');
    };

    const handleFileChange = (e) => {
        const f = e.target.files[0];
        if (!f) return;
        cancelPrefetch();
        const nextDocumentId = documentFingerprint(f);
        const progress = loadReadingProgress(nextDocumentId);
        setDocumentId(nextDocumentId);
        setBookmarks(progress.bookmarks);
        savedResumeRef.current = { page: progress.page, time: progress.time };
        transport.setRate(progress.playbackRate);
        setFile(f);
        fileRef.current = f;
        resetDocument();
        setNumPages(null);
        setPageNumber(progress.page);
        pageNumberRef.current = progress.page;
        setAudioUrl(null);
        setAudioPage(null);
        audioPageRef.current = null;
        setPageText('');
        pageTextRef.current = '';
        setPageWords([]);
        pageWordsRef.current = [];
        wordTimesRef.current = [];
        segmentsRef.current = [];
        cacheRef.current.clear();
        audioVoiceRef.current = null;
        setZoom(progress.zoom);
        setDisplayZoom(progress.zoom);
        clearPlaybackState();
        onDirty?.();
    };

    const handleSearch = async (event) => {
        event?.preventDefault?.();
        if (!searchQuery.trim() || !numPages) return;
        setIsSearching(true);
        try {
            const found = await findTextInDocument(searchQuery, pageNumber + 1);
            if (found) {
                await loadPageIntoView(found, { autoplay: false });
                toast.success(`Found on page ${found}`);
            } else {
                toast.info('Text was not found in the PDF text layer.');
            }
        } catch (error) {
            toast.error(error.message || 'Search failed');
        } finally {
            setIsSearching(false);
        }
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
                        {deviceInfo === 'cpu'
                            ? 'Text PDFs read instantly. TTS on CPU is slow — nearby page prefetch is disabled.'
                            : 'Text PDFs read instantly. Nearby pages warm in the background for seamless flipping.'}
                    </p>
                </div>
            ) : (
                <>
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
                                    onLoadSuccess={(pdf) => {
                                        adoptPdfDocument(pdf);
                                        setNumPages(pdf.numPages);
                                        const restoredPage = Math.max(
                                            1,
                                            Math.min(pdf.numPages, pageNumberRef.current)
                                        );
                                        setPageNumber(restoredPage);
                                        pageNumberRef.current = restoredPage;
                                        schedulePrefetchSafe(restoredPage, pdf.numPages);
                                    }}
                                    loading={
                                        <div className="pdf-loading">
                                            <Loader2 className="spinner" size={40} />
                                        </div>
                                    }
                                >
                                    <div
                                        className="pdf-page-wrapper pdf-page-current"
                                        style={{
                                            transform: `scale(${displayZoom})`,
                                            transformOrigin: 'top center',
                                        }}
                                    >
                                        <Page
                                            pageNumber={pageNumber}
                                            width={basePageWidth}
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
                            <div className="pdf-transcript-actions">
                                <button
                                    type="button"
                                    className="btn secondary btn-compact"
                                    onClick={() => {
                                        setEditTextDraft(pageText);
                                        setIsEditingText((v) => !v);
                                    }}
                                    disabled={!pageText}
                                >
                                    {isEditingText ? 'Cancel edit' : 'Edit text'}
                                </button>
                                <button
                                    type="button"
                                    className="btn secondary btn-compact"
                                    onClick={handleTranslatePage}
                                    disabled={!pageText || isGenerating}
                                >
                                    Translate
                                </button>
                            </div>
                            {isEditingText ? (
                                <div className="pdf-text-edit-wrap">
                                    <textarea
                                        className="pdf-text-edit"
                                        value={editTextDraft}
                                        onChange={(e) => setEditTextDraft(e.target.value)}
                                    />
                                    <button
                                        type="button"
                                        className="btn primary btn-compact"
                                        onClick={handleSaveEditedText}
                                    >
                                        Save text
                                    </button>
                                </div>
                            ) : (
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
                            )}
                        </div>
                    </div>

                    <div className="pdf-toolbar">
                        <div className="pdf-toolbar-voice">
                            <VoiceSettings
                                compact
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

                            <form className="page-search" onSubmit={handleSearch}>
                                <Search size={14} />
                                <input
                                    type="search"
                                    value={searchQuery}
                                    onChange={(event) => setSearchQuery(event.target.value)}
                                    placeholder="Find in book"
                                    aria-label="Find text in book"
                                />
                                <button
                                    type="submit"
                                    className="btn secondary btn-compact"
                                    disabled={!searchQuery.trim() || isSearching}
                                >
                                    {isSearching ? <Loader2 className="spinner" size={14} /> : 'Find'}
                                </button>
                            </form>

                            <div className="bookmark-controls">
                                <button
                                    type="button"
                                    className="btn secondary btn-compact"
                                    onClick={() => setBookmarks((items) => toggleBookmark(items, pageNumber))}
                                    aria-label={bookmarks.includes(pageNumber) ? 'Remove bookmark' : 'Bookmark page'}
                                    title={bookmarks.includes(pageNumber) ? 'Remove bookmark' : 'Bookmark page'}
                                >
                                    {bookmarks.includes(pageNumber) ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
                                </button>
                                {bookmarks.length ? (
                                    <select
                                        value=""
                                        onChange={(event) => {
                                            if (event.target.value) goToPage(Number(event.target.value));
                                        }}
                                        aria-label="Go to bookmark"
                                    >
                                        <option value="">Bookmarks</option>
                                        {bookmarks.map((page) => <option key={page} value={page}>Page {page}</option>)}
                                    </select>
                                ) : null}
                            </div>

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
                            <PlaybackControls
                                compact
                                transport={{ ...transport, isPlaying }}
                                onToggle={handlePlay}
                                disabled={playBtn.disabled}
                            />
                            {audioUrl && audioPage === pageNumber ? (
                                <a
                                    className="btn secondary btn-compact"
                                    href={audioUrl}
                                    download={`${(file?.name || 'book').replace(/\.pdf$/i, '')}-page-${pageNumber}.wav`}
                                    aria-label="Download page audio"
                                    title="Download page audio"
                                >
                                    <Download size={15} />
                                </a>
                            ) : null}
                            <button
                                className="btn secondary btn-compact"
                                onClick={() => goToPage(pageNumber + 1)}
                                disabled={pageNumber >= numPages}
                            >
                                <ChevronDown size={15} />
                            </button>
                        </div>
                    </div>
                </>
            )}
            <audio ref={audioRef} style={{ display: 'none' }} preload="auto" />
            <audio ref={pronounceRef} style={{ display: 'none' }} preload="auto" />
        </div>
    );
}
