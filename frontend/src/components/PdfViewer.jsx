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
    ScanText,
    ZoomIn,
    ZoomOut,
    Maximize2,
    Bookmark,
    BookmarkCheck,
    Download,
    Search,
    SlidersHorizontal,
    LocateFixed,
} from 'lucide-react';
import {
    createBookArchive,
    createBookPreparation,
    cancelBookPreparation,
    exportCachedAudio,
    getBookPreparation,
    getPreparedBook,
    getPreparedPage,
    importPreparedBook,
    listPreparedBooks,
    narrateTextStream,
    preparedBookSource,
    pronounceText,
    savePreparedPage,
    translateText,
    updatePreparedProgress,
} from '../utils/api';
import { createSessionId } from '../utils/session';
import { SUPPORTED_LANGUAGES } from '../utils/languages';
import { canonicalAudioUrl, createPageAudioCache, cacheKey } from '../utils/pageAudioCache';
import { clearPdfHighlights } from '../utils/pdfHighlight';
import { useToast } from './Toast';
import { useTtsStatus } from '../hooks/useTtsStatus';
import { useUserConfig } from '../hooks/useUserConfig';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import VoiceSettings from './VoiceSettings';
import Transcript from './Transcript';
import PlaybackControls from './PlaybackControls';
import PreparationProgress from './PreparationProgress';
import { useAudioTransport } from '../hooks/useAudioTransport';
import { audioRangeForWord, waitForAudioMetadata } from '../utils/media';
import {
    normalizePronunciationText,
    pronounceWithSystemVoice,
    stopSystemPronunciation,
} from '../utils/wordPronunciation';
import { resolvePageContent } from '../utils/pageContentResolver';
import {
    activePreparedProfile,
    missingPreparedTextPages,
    preparedBookDetails,
    preparationForActiveProfile,
} from '../utils/preparedPages';
import {
    documentFingerprint,
    loadReadingProgress,
    saveReadingProgress,
    toggleBookmark,
} from '../utils/readingProgress';
import { shouldDisableFollowNarration } from '../utils/readerNavigation';
import { shouldDisableNarrationStart } from '../utils/readerPlaybackState';
import { shouldZoomPdfWheel } from '../utils/pdfInteraction';
import { mapWithConcurrency } from '../utils/boundedConcurrency';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

import { usePdfDocument } from '../hooks/usePdfDocument';
import { useWordHighlight } from '../hooks/useWordHighlight';
import { usePageNarration } from '../hooks/usePageNarration';
import { usePrefetch } from '../hooks/usePrefetch';
import {
    buildPlaylist,
    globalTimeForChunk,
    nextChunkIndex,
    playbackTargetAtGlobalTime,
} from '../utils/playlistController';
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 2.6;
const ZOOM_STEP = 0.15;

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
    const [transportState, setTransportState] = useState('idle');
    const [followNarration, setFollowNarration] = useState(
        () => {
            try {
                return localStorage.getItem('bookvoice:follow-narration') === 'true';
            } catch {
                return false;
            }
        }
    );
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
    const [isExporting, setIsExporting] = useState(false);
    const [showReadingOptions, setShowReadingOptions] = useState(false);
    const [libraryBooks, setLibraryBooks] = useState([]);
    const [libraryBookId, setLibraryBookId] = useState(null);
    const [activeProfileId, setActiveProfileId] = useState(null);
    const [preparation, setPreparation] = useState(null);
    const [isCancellingPreparation, setIsCancellingPreparation] = useState(false);

    const audioRef = useRef(null);
    const pronounceRef = useRef(null);
    const pronounceStopTimerRef = useRef(0);
    const currentEntryRef = useRef(null);
    const containerRef = useRef(null);
    const fileRef = useRef(null);
    const pageWordsRef = useRef([]);
    const wordTimesRef = useRef([]);
    // Measured word end times + how the current timings were produced
    // ('aligned' = backend forced alignment, 'estimate' = heuristics). The
    // paused word-click flow only slices cached page audio when aligned.
    const wordEndsRef = useRef([]);
    const timingModeRef = useRef('estimate');
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
    // Progressive chunk streaming: the current chunk's start_s offset (added to
    // audio.currentTime for global highlight lookup). 0 for single-shot audio.
    const audioTimeOffsetRef = useRef(0);
    const playlistRef = useRef([]); // [{url, start_s, end_s}] for the active page
    const playlistIndexRef = useRef(0); // current chunk index in the playlist
    const playlistExpectedTotalRef = useRef(0);
    const playlistWaitingRef = useRef(false);
    const playlistShouldPlayRef = useRef(false);
    const playlistSeekGenerationRef = useRef(0);
    const chunkPreloadsRef = useRef(new Map());
    const timelineRef = useRef(null);
    const streamAbortRef = useRef(null); // AbortController for an in-flight stream
    const browseRequestRef = useRef(0);
    const advancePlaylistRef = useRef(() => {}); // set by the streaming effect
    const handlePlayRef = useRef(() => {});
    const openLibraryBookRef = useRef(() => {});
    const startupBookOpenedRef = useRef(false);
    const autoResumedPreparationRef = useRef('');
    const transport = useAudioTransport(audioRef, timelineRef);
    const {
        refresh: refreshTransport,
        seekTo: seekTransportTo,
        setRate: setTransportRate,
        skipBy: skipTransportBy,
    } = transport;

    langRef.current = targetLanguage;
    pageTextRef.current = pageText;
    pageNumberRef.current = pageNumber;
    audioPageRef.current = audioPage;
    isPlayingRef.current = isPlaying;
    currentWordRef.current = currentWord;
    activeVoiceRef.current = activeVoiceId;
    isGeneratingRef.current = isGenerating;

    useEffect(() => {
        try {
            localStorage.setItem('bookvoice:follow-narration', String(followNarration));
        } catch {
            /* Reading still works when browser storage is unavailable. */
        }
    }, [followNarration]);

    useEffect(() => {
        listPreparedBooks().then((books) => {
            setLibraryBooks(books);
            const startupBookId = new URLSearchParams(window.location.search).get('book');
            const startupBook = books.find((book) => book.id === startupBookId);
            if (startupBook && !startupBookOpenedRef.current) {
                startupBookOpenedRef.current = true;
                openLibraryBookRef.current(startupBook);
            }
        }).catch((error) => {
            toast.error(error.message || 'Could not load the prepared-book library.');
        });
    }, [toast]);

    useEffect(() => {
        if (!preparation?.id || !['QUEUED', 'RUNNING'].includes(preparation.status)) return;
        const timer = setInterval(async () => {
            try {
                const next = await getBookPreparation(preparation.id);
                setPreparation(next);
                if (next.status === 'COMPLETED') {
                    setActiveProfileId(next.profileId);
                    listPreparedBooks().then(setLibraryBooks).catch(() => {});
                }
            } catch {
                /* retain the last visible progress state */
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [preparation?.id, preparation?.status]);

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
        wordEndsRef,
        audioTimeOffsetRef,
        viewPageRef: pageNumberRef,
        audioPageRef,
    });

    const { narratePage, cancelGeneration } = usePageNarration({
        sessionId,
        activeVoiceRef,
        langRef,
        cacheRef,
        buildTimings,
        bookId: libraryBookId,
    });

    const { cancelPrefetch, schedulePrefetch } = usePrefetch({
        cacheRef,
        activeVoiceRef,
        langRef,
        modelReady,
        isGeneratingRef,
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

    useEffect(
        () => () => {
            stopSystemPronunciation();
            clearTimeout(pronounceStopTimerRef.current);
        },
        []
    );

    // Propagate narration language to the document direction for RTL/LTR chrome.
    useEffect(() => {
        const previousDir = document.documentElement.dir;
        const previousLang = document.documentElement.lang;
        document.documentElement.dir = targetLanguage === 'ar' ? 'rtl' : 'ltr';
        document.documentElement.lang = targetLanguage || 'en';
        return () => {
            document.documentElement.dir = previousDir;
            document.documentElement.lang = previousLang;
        };
    }, [targetLanguage]);

    // Keyboard shortcuts: Space = play/pause, ←/→ = seek ±10s.
    // Ignored while typing in inputs/textareas/contenteditable.
    useEffect(() => {
        const handler = (e) => {
            const tag = e.target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (e.target?.isContentEditable) return;
            if (e.code === 'Space') {
                e.preventDefault();
                handlePlayRef.current();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                skipTransportBy(-10);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                skipTransportBy(10);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [skipTransportBy]);

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

    useEffect(() => {
        if (!libraryBookId) return undefined;
        const timer = setTimeout(() => {
            updatePreparedProgress(libraryBookId, {
                page: pageNumber,
                time: transport.currentTime,
                bookmarks,
                updatedAt: Math.floor(Date.now() / 1000),
            }).then((progress) => {
                setLibraryBooks((books) => books.map((book) => (
                    book.id === libraryBookId ? { ...book, progress } : book
                )));
            }).catch(() => {});
        }, 500);
        return () => clearTimeout(timer);
    }, [bookmarks, libraryBookId, pageNumber, transport.currentTime]);

    useEffect(() => {
        if (!modelReady || !libraryBookId || preparation?.status !== 'PAUSED') return;
        const resumeKey = `${libraryBookId}:${preparation.profileId || ''}`;
        if (autoResumedPreparationRef.current === resumeKey) return;
        autoResumedPreparationRef.current = resumeKey;
        createBookPreparation(
            libraryBookId,
            preparation.voiceId || null,
            preparation.languageId || 'en'
        ).then(setPreparation).catch(() => {
            autoResumedPreparationRef.current = '';
        });
    }, [libraryBookId, modelReady, preparation]);

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
        playlistShouldPlayRef.current = false;
        if (audioRef.current) audioRef.current.pause();
        setIsPlaying(false);
        setTransportState('paused');
        isPlayingRef.current = false;
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
        }
    }, [rafRef]);

    const stopPlayback = useCallback(() => {
        stopSystemPronunciation();
        if (streamAbortRef.current) streamAbortRef.current.abort();
        cancelGeneration();
        playlistRef.current = [];
        playlistIndexRef.current = 0;
        playlistExpectedTotalRef.current = 0;
        playlistWaitingRef.current = false;
        playlistShouldPlayRef.current = false;
        playlistSeekGenerationRef.current += 1;
        chunkPreloadsRef.current.clear();
        timelineRef.current = null;
        audioTimeOffsetRef.current = 0;
        const audio = audioRef.current;
        if (audio) {
            audio.pause();
            const canonicalUrl = canonicalAudioUrl(currentEntryRef.current, {
                page: pageNumberRef.current,
                voiceId: activeVoiceRef.current,
                languageId: langRef.current,
            });
            if (canonicalUrl) {
                audio.src = canonicalUrl;
            } else {
                audio.removeAttribute('src');
                currentEntryRef.current = null;
                setAudioUrl(null);
                setAudioPage(null);
                audioPageRef.current = null;
            }
            try {
                audio.currentTime = 0;
            } catch {
                /* ignore */
            }
        }
        if (pronounceRef.current) pronounceRef.current.pause();
        clearTimeout(pronounceStopTimerRef.current);
        setIsPlaying(false);
        isPlayingRef.current = false;
        setIsGenerating(false);
        isGeneratingRef.current = false;
        setTransportState('stopped');
        setCurrentWord(0);
        currentWordRef.current = 0;
        setStatusHint('');
        syncHighlightAt(0);
        refreshTransport();
    }, [cancelGeneration, refreshTransport, syncHighlightAt]);

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
        (words, times, { ends = [], mode = 'estimate' } = {}) => {
            setPageWords(words);
            pageWordsRef.current = words;
            wordTimesRef.current = times;
            wordEndsRef.current = ends;
            timingModeRef.current = mode;
            requestAnimationFrame(() => rebindWordSpans());
        },
        [rebindWordSpans]
    );

    const seekPlaylistGlobal = useCallback(
        (requestedTime, media = audioRef.current) => {
            const playlist = buildPlaylist(playlistRef.current);
            const target = playbackTargetAtGlobalTime(playlist, requestedTime);
            if (!media || !target) return 0;

            const seekGeneration = ++playlistSeekGenerationRef.current;
            const shouldResume = playlistShouldPlayRef.current;
            const playbackRate = Number(media.playbackRate) || 1;
            playlistIndexRef.current = target.chunkIndex;
            audioTimeOffsetRef.current = target.chunk.start_s;
            playlistWaitingRef.current = false;

            const commitSeek = () => {
                if (seekGeneration !== playlistSeekGenerationRef.current) return;
                try {
                    media.currentTime = target.localTime;
                } catch {
                    return;
                }
                media.playbackRate = playbackRate;
                syncHighlightAt(target.localTime);
                refreshTransport();
                media.dispatchEvent(new Event('seeked'));
                if (shouldResume) media.play().catch(() => {});
            };

            const currentSource = media.currentSrc || media.src || media.getAttribute('src');
            if (currentSource === target.chunk.url || media.getAttribute('src') === target.chunk.url) {
                commitSeek();
            } else {
                media.src = target.chunk.url;
                media.playbackRate = playbackRate;
                if (media.readyState >= 1) commitSeek();
                else media.addEventListener('loadedmetadata', commitSeek, { once: true });
            }
            setTransportState(shouldResume ? 'playing' : 'paused');
            return target.globalTime;
        },
        [refreshTransport, syncHighlightAt]
    );

    const installPlaylistTimeline = useCallback(() => {
        timelineRef.current = {
            getCurrentTime: (media) => globalTimeForChunk(
                buildPlaylist(playlistRef.current),
                playlistIndexRef.current,
                Number(media?.currentTime) || 0
            ),
            getDuration: () => buildPlaylist(playlistRef.current).totalDurationS,
            seekTo: seekPlaylistGlobal,
        };
        refreshTransport();
    }, [refreshTransport, seekPlaylistGlobal]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const handlePlay = () => {
            setIsPlaying(true);
            setTransportState('playing');
            isPlayingRef.current = true;
            startHighlightLoop();
        };
        const handlePause = () => {
            setIsPlaying(false);
            setTransportState((state) => (state === 'stopped' ? state : 'paused'));
            isPlayingRef.current = false;
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = 0;
            }
            if (audio.currentTime != null) syncHighlightAt(audio.currentTime);
        };
        const handleEnded = () => {
            // If a next playlist chunk exists, advance to it (gapless streaming).
            if (playlistRef.current.length > 0) {
                const advanced = advancePlaylistRef.current();
                if (advanced) return;
                if (
                    isGeneratingRef.current &&
                    playlistIndexRef.current + 1 < playlistExpectedTotalRef.current
                ) {
                    playlistWaitingRef.current = true;
                    // Keep the transport intent active so the primary control
                    // remains Pause while generation catches up.
                    setIsPlaying(true);
                    setTransportState('buffering');
                    isPlayingRef.current = true;
                    if (rafRef.current) {
                        cancelAnimationFrame(rafRef.current);
                        rafRef.current = 0;
                    }
                    return;
                }
            }
            // Soft end: leave resume on last word
            playlistShouldPlayRef.current = false;
            setIsPlaying(false);
            setTransportState('stopped');
            isPlayingRef.current = false;
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = 0;
            }
            const narratedWordCount =
                currentEntryRef.current?.words?.length || wordTimesRef.current.length;
            const last = Math.max(0, narratedWordCount - 1);
            setCurrentWord(last);
            currentWordRef.current = last;
        };
        const handleSeeked = () => syncHighlightAt(Number(audio.currentTime) || 0);

        audio.addEventListener('play', handlePlay);
        audio.addEventListener('pause', handlePause);
        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('seeked', handleSeeked);
        return () => {
            audio.removeEventListener('play', handlePlay);
            audio.removeEventListener('pause', handlePause);
            audio.removeEventListener('ended', handleEnded);
            audio.removeEventListener('seeked', handleSeeked);
            stopHighlightLoop();
        };
    }, [rafRef, startHighlightLoop, stopHighlightLoop, syncHighlightAt]);

    const onPageRenderSuccess = useCallback(() => {
        requestAnimationFrame(() => rebindWordSpans());
    }, [rebindWordSpans]);

    /**
     * Apply a ready cache entry (or fresh result) to the main player.
     */
    const applyReadyAudio = useCallback(
        async (entry, { autoplay, resumeWordIndex = 0 }) => {
            const audio = audioRef.current;
            if (!audio || !entry?.audioUrl) return;

            playlistSeekGenerationRef.current += 1;
            playlistRef.current = [];
            playlistIndexRef.current = 0;
            playlistExpectedTotalRef.current = 0;
            playlistWaitingRef.current = false;
            playlistShouldPlayRef.current = autoplay;
            chunkPreloadsRef.current.clear();
            timelineRef.current = null;
            audioTimeOffsetRef.current = 0;

            segmentsRef.current = entry.segments || [];
            currentEntryRef.current = entry;
            setAudioUrl(entry.audioUrl);
            setAudioPage(entry.page);
            audioPageRef.current = entry.page;
            audioVoiceRef.current = entry.voiceId ?? null;
            setPageText(entry.text);
            pageTextRef.current = entry.text;

            audio.src = entry.audioUrl;
            await waitForAudioMetadata(audio);
            refreshTransport();

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
                entry.ends = built.ends || [];
                entry.timingMode = built.mode || 'estimate';
            }
            applyWordState(words, times, {
                ends: entry.ends || [],
                mode: entry.timingMode || 'estimate',
            });
            requestAnimationFrame(() => rebindWordSpans());

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
                try {
                    await audio.play();
                    setIsPlaying(true);
                    setTransportState('playing');
                    isPlayingRef.current = true;
                    startHighlightLoop();
                } catch (error) {
                    setIsPlaying(false);
                    isPlayingRef.current = false;
                    toast.error(error?.message || 'Audio playback was blocked. Press Play again.');
                }
            } else {
                setIsPlaying(false);
                setTransportState('paused');
                isPlayingRef.current = false;
            }
        },
        [applyWordState, buildTimings, rebindWordSpans, refreshTransport, startHighlightLoop, syncHighlightAt, toast]
    );

    /**
     * Stream TTS generation, but hold playback until the final canonical WAV
     * and its full page timing map are ready. A partial chunk cannot provide
     * reliable word highlighting, so it must never reach the player.
     */
    const generateAndPlayStreamed = useCallback(
        async (pageNum, text, { autoplay = true, voiceId = activeVoiceRef.current } = {}) => {
            const audio = audioRef.current;
            if (!audio) return null;

            // Reset playlist state for the new page.
            if (streamAbortRef.current) streamAbortRef.current.abort();
            streamAbortRef.current = new AbortController();
            const signal = streamAbortRef.current.signal;
            const requestId = `${sessionId}-${crypto.randomUUID()}`;
            playlistRef.current = [];
            playlistIndexRef.current = 0;
            playlistExpectedTotalRef.current = 0;
            playlistWaitingRef.current = false;
            playlistShouldPlayRef.current = autoplay;
            playlistSeekGenerationRef.current += 1;
            chunkPreloadsRef.current.clear();
            audioTimeOffsetRef.current = 0;
            installPlaylistTimeline();

            setAudioPage(pageNum);
            audioPageRef.current = pageNum;
            audioVoiceRef.current = voiceId ?? null;
            currentEntryRef.current = null;
            setAudioUrl(null);
            setPageText(text);
            pageTextRef.current = text;
            const words = text.split(/\s+/).filter(Boolean);
            setPageWords(words);
            pageWordsRef.current = words;

            let doneEvent = null;
            const collectedChunks = [];

            // Playlist advance: called by the `ended` handler when a chunk ends.
            advancePlaylistRef.current = () => {
                const playlist = buildPlaylist(playlistRef.current);
                const next = nextChunkIndex(playlist, playlistIndexRef.current);
                if (next == null) return false;
                const chunk = playlist.chunks[next];
                const playbackRate = Number(audio.playbackRate) || 1;
                playlistIndexRef.current = next;
                audioTimeOffsetRef.current = chunk.start_s;
                playlistWaitingRef.current = false;
                playlistSeekGenerationRef.current += 1;
                audio.src = chunk.url;
                audio.playbackRate = playbackRate;
                try {
                    audio.currentTime = 0;
                } catch {
                    /* metadata will initialize the chunk at zero */
                }
                refreshTransport();
                if (playlistShouldPlayRef.current) audio.play().catch(() => {});
                else setTransportState('paused');
                return true;
            };

            await narrateTextStream(
                text,
                sessionId,
                pageNum,
                voiceId,
                langRef.current,
                {
                    bookId: libraryBookId,
                    requestId,
                    onChunk: async (event) => {
                        if (event.type === 'chunk') {
                            collectedChunks.push(event);
                            playlistRef.current = collectedChunks;
                            playlistExpectedTotalRef.current = Number(event.total) || collectedChunks.length;
                        } else if (event.type === 'done') {
                            doneEvent = event;
                        }
                    },
                },
                signal
            );

            // Assemble full-page timings from the done event (if it arrived).
            if (!doneEvent) {
                return null; // stream was cancelled or errored
            }

            const duration = doneEvent.duration_s || 0;
            const built = await buildTimings(
                text,
                doneEvent.segments || [],
                duration,
                doneEvent.audio_url,
                doneEvent.word_timings
            );

            const entry = {
                status: 'ready',
                page: pageNum,
                voiceId: voiceId ?? null,
                languageId: langRef.current,
                text,
                audioUrl: doneEvent.audio_url,
                segments: doneEvent.segments || [],
                duration_s: duration,
                words: built.words,
                times: built.times,
                ends: built.ends || [],
                timingMode: built.mode || 'estimate',
                fromWord: 0,
                partial: false,
            };

            const key = cacheKey(pageNum, voiceId, langRef.current);
            cacheRef.current.set(key, entry);
            currentEntryRef.current = entry;
            setAudioUrl(entry.audioUrl);
            applyWordState(entry.words, entry.times, {
                ends: entry.ends,
                mode: entry.timingMode,
            });

            // Promote the completed canonical WAV without losing the logical
            // position, pause state, or playback speed from the chunk playlist.
            const logicalTime = timelineRef.current?.getCurrentTime?.(audio) || 0;
            const shouldContinue =
                playlistShouldPlayRef.current && logicalTime < Math.max(0, duration - 0.01);
            const playbackRate = Number(audio.playbackRate) || 1;
            playlistSeekGenerationRef.current += 1;
            playlistRef.current = [];
            playlistIndexRef.current = 0;
            playlistExpectedTotalRef.current = 0;
            playlistWaitingRef.current = false;
            chunkPreloadsRef.current.clear();
            timelineRef.current = null;
            audioTimeOffsetRef.current = 0;
            audio.src = entry.audioUrl;
            await waitForAudioMetadata(audio);
            audio.playbackRate = playbackRate;
            try {
                audio.currentTime = Math.max(
                    0,
                    Math.min(logicalTime, Number(audio.duration) || duration || logicalTime)
                );
            } catch {
                /* keep the canonical audio at its default position */
            }
            refreshTransport();
            syncHighlightAt(Number(audio.currentTime) || 0);
            if (shouldContinue) {
                await audio.play().catch(() => {});
            } else {
                playlistShouldPlayRef.current = false;
                setIsPlaying(false);
                isPlayingRef.current = false;
                setTransportState(logicalTime >= duration ? 'stopped' : 'paused');
            }
            return entry;
        },
        [
            applyWordState,
            buildTimings,
            installPlaylistTimeline,
            libraryBookId,
            sessionId,
            syncHighlightAt,
            refreshTransport,
        ]
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
            setTransportState('buffering');
            isGeneratingRef.current = true;
            try {
                // Full-page, non-cached narration: stream chunks for first-audio-early.
                // Partial clips and cache misses fall back to single-shot narratePage.
                if (!partialFromResume) {
                    try {
                        const entry = await generateAndPlayStreamed(pageNum, text, {
                            autoplay,
                            voiceId,
                        });
                        onDirty?.();
                        return entry;
                    } catch (streamErr) {
                        if (streamErr?.name === 'AbortError') return null;
                        // Fall back to the single-shot path on stream failure.
                    }
                }
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
                setTransportState((state) => (state === 'buffering' ? 'paused' : state));
                setStatusHint('');
            }
        },
        [applyReadyAudio, generateAndPlayStreamed, narratePage, onDirty, toast]
    );

    const loadPageIntoView = useCallback(
        async (pageNum, { autoplay = false } = {}) => {
            browseRequestRef.current += 1;
            cancelPrefetch();
            cancelGeneration();
            if (streamAbortRef.current) streamAbortRef.current.abort();
            playlistRef.current = [];
            playlistIndexRef.current = 0;
            playlistExpectedTotalRef.current = 0;
            playlistWaitingRef.current = false;
            playlistShouldPlayRef.current = false;
            playlistSeekGenerationRef.current += 1;
            chunkPreloadsRef.current.clear();
            timelineRef.current = null;
            audioTimeOffsetRef.current = 0;
            pauseAudio();
            refreshTransport();
            setPageNumber(pageNum);
            pageNumberRef.current = pageNum;

            try {
                const resolved = await resolvePageContent({
                    bookId: libraryBookId,
                    profileId: activeProfileId,
                    page: pageNum,
                    getPreparedPage,
                    preparePageText: (page) => preparePageText(page, { setIsOcring }),
                });
                const { text, prepared, source } = resolved;
                setPageText(text);
                pageTextRef.current = text;
                setPageWords(text.split(/\s+/).filter(Boolean));
                pageWordsRef.current = text.split(/\s+/).filter(Boolean);
                cachePageText(pageNum, text);

                if (libraryBookId && source !== 'prepared') {
                    await savePreparedPage(libraryBookId, pageNum, text, numPages || pageNum);
                }

                if (prepared?.audioUrl) {
                    const times = (prepared.wordTimings || []).map((item) => Number(item.start_s) || 0);
                    const words = (prepared.wordTimings || []).map((item) => item.word);
                    const ends = (prepared.wordTimings || []).map((item) => Number(item.end_s) || 0);
                    const entry = {
                        status: 'ready',
                        page: pageNum,
                        voiceId: activeVoiceRef.current,
                        languageId: langRef.current,
                        text,
                        audioUrl: prepared.audioUrl,
                        segments: [],
                        duration_s: prepared.audio?.duration || 0,
                        words: words.length ? words : text.split(/\s+/).filter(Boolean),
                        times,
                        ends: times.length ? ends : [],
                        timingMode: times.length ? 'aligned' : 'estimate',
                        fromWord: 0,
                        partial: false,
                    };
                    cacheRef.current.set(cacheKey(pageNum, activeVoiceRef.current, langRef.current), entry);
                    await applyReadyAudio(entry, { autoplay, resumeWordIndex: 0 });
                    return;
                }

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
                    wordEndsRef.current = [];
                    timingModeRef.current = 'estimate';
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
            cachePageText,
            cancelGeneration,
            cancelPrefetch,
            generateAndPlay,
            activeProfileId,
            libraryBookId,
            modelReady,
            numPages,
            pauseAudio,
            preparePageText,
            schedulePrefetchSafe,
            toast,
            refreshTransport,
        ]
    );

    // Browsing is deliberately separate from narration. Turning a page must
    // not abort generation, pause audio, clear its playlist, or replace its
    // word timings. The active narrated page remains the transport source.
    const browsePageIntoView = useCallback(
        async (pageNum) => {
            if (
                shouldDisableFollowNarration({
                    isPlaying: isPlayingRef.current,
                    narratedPage: audioPageRef.current,
                    targetPage: pageNum,
                })
            ) {
                setFollowNarration(false);
            }
            const requestId = ++browseRequestRef.current;
            setPageNumber(pageNum);
            pageNumberRef.current = pageNum;
            clearPdfHighlights(containerRef.current || document);
            prevHighlightSpanRef.current = null;
            try {
                const { text, source } = await resolvePageContent({
                    bookId: libraryBookId,
                    profileId: activeProfileId,
                    page: pageNum,
                    getPreparedPage,
                    preparePageText: (page) => preparePageText(page, { setIsOcring }),
                });
                if (requestId !== browseRequestRef.current) return;
                const words = text.split(/\s+/).filter(Boolean);
                setPageText(text);
                pageTextRef.current = text;
                setPageWords(words);
                pageWordsRef.current = words;
                cachePageText(pageNum, text);
                if (libraryBookId && source !== 'prepared') {
                    await savePreparedPage(libraryBookId, pageNum, text, numPages || pageNum);
                }
                requestAnimationFrame(() => rebindWordSpans());
            } catch (error) {
                if (requestId !== browseRequestRef.current) return;
                toast.error(error.message || 'Could not open that page');
            }
        },
        [
            activeProfileId,
            cachePageText,
            libraryBookId,
            numPages,
            preparePageText,
            prevHighlightSpanRef,
            rebindWordSpans,
            toast,
        ]
    );

    const goToPage = (next) => {
        if (!numPages) return;
        const n = Math.max(1, Math.min(numPages, next));
        if (n === pageNumber) return;
        browsePageIntoView(n);
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
            const narratedPage = audioPageRef.current;
            const page = narratedPage ?? pageNumberRef.current;
            const text = narratedPage
                ? currentEntryRef.current?.text || ''
                : pageTextRef.current;
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

        const audio = audioRef.current;
        if (playlistWaitingRef.current && isPlaying) {
            pauseAudio();
            return;
        }
        if (audio && !audio.paused && !audio.ended) {
            pauseAudio();
            return;
        }

        stopSystemPronunciation();

        // A progressive stream already owns the player. Resume its current
        // chunk or wait for the next one instead of starting duplicate TTS.
        if (playlistRef.current.length && audio) {
            playlistShouldPlayRef.current = true;
            if (playlistWaitingRef.current || audio.ended) {
                if (!advancePlaylistRef.current()) {
                    playlistWaitingRef.current = true;
                    setTransportState('buffering');
                    return;
                }
                return;
            }
            try {
                await audio.play();
                setIsPlaying(true);
                isPlayingRef.current = true;
                setTransportState('playing');
                startHighlightLoop();
            } catch (error) {
                toast.error(error?.message || 'Audio playback was blocked. Press Play again.');
            }
            return;
        }

        // Resume existing audio for this page
        if (audioUrl && audioPage === pageNumber && audioRef.current?.src) {
            try {
                await audioRef.current.play();
                setIsPlaying(true);
                isPlayingRef.current = true;
                startHighlightLoop();
            } catch (error) {
                toast.error(error?.message || 'Audio playback was blocked. Press Play again.');
            }
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
    handlePlayRef.current = handlePlay;

    const handleExportThroughCurrentPage = async () => {
        if (!file || isExporting) return;
        setIsExporting(true);
        try {
            const { audioUrl, pages } = await exportCachedAudio(sessionId, 1, pageNumber);
            const link = document.createElement('a');
            link.href = audioUrl;
            link.download = `${(file.name || 'book').replace(/\.pdf$/i, '')}-pages-1-${pageNumber}.wav`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            toast.success(`Exported ${pages.length} page${pages.length === 1 ? '' : 's'}.`);
        } catch (error) {
            toast.error(error?.message || 'Could not export cached page audio.');
        } finally {
            setIsExporting(false);
        }
    };

    const handleResume = async () => {
        setShowResumeChoice(false);
        if (audioRef.current) {
            try {
                await audioRef.current.play();
                setIsPlaying(true);
                isPlayingRef.current = true;
                startHighlightLoop();
            } catch (error) {
                toast.error(error?.message || 'Audio playback was blocked. Press Play again.');
            }
        }
    };

    const handleReadNewPage = async () => {
        setShowResumeChoice(false);
        await loadPageIntoView(pageNumber, { autoplay: true });
    };

    const handleForceOcr = async () => {
        if (!file) return;
        try {
            invalidateTextCache(pageNumber);
            const text = await preparePageText(pageNumber, { forceOcr: true, setIsOcring });
            setPageText(text);
            pageTextRef.current = text;
            if (libraryBookId) {
                await savePreparedPage(libraryBookId, pageNumber, text, numPages || pageNumber);
            }
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
            const t = Math.max(0, times[idx] ?? 0);
            if (audioRef.current && audioPageRef.current === pageNumberRef.current) {
                seekTransportTo(t);
            }
        },
        [seekTransportTo]
    );

    const pronounceWord = useCallback(
        async (word, index) => {
            const clean = normalizePronunciationText(word);
            if (!clean) return;
            const el = pronounceRef.current;
            // A new word click always wins over an older neural clip.
            if (el && !el.paused) el.pause();
            // Replaying a slice of the cached page audio is only trustworthy
            // when the timings were force-aligned by the backend. Estimated
            // timings drift, and a wrong slice speaks a different word — so
            // fall through and synthesize the exact word instead.
            const cachedPageReady =
                timingModeRef.current === 'aligned' &&
                audioPageRef.current === pageNumberRef.current &&
                currentEntryRef.current?.audioUrl &&
                wordTimesRef.current.length;
            if (cachedPageReady && el) {
                const range = audioRangeForWord(
                    wordTimesRef.current,
                    index,
                    currentEntryRef.current.duration_s || audioRef.current?.duration || 0,
                    wordEndsRef.current
                );
                clearTimeout(pronounceStopTimerRef.current);
                el.pause();
                el.src = currentEntryRef.current.audioUrl;
                await waitForAudioMetadata(el);
                // Small pre-roll so a leading plosive isn't clipped.
                const sliceStart = Math.max(0, range.start - 0.04);
                el.currentTime = sliceStart;
                await el.play();
                pronounceStopTimerRef.current = setTimeout(
                    () => el.pause(),
                    Math.max(120, (range.end - sliceStart) * 1000)
                );
                return;
            }
            // System speech is immediate, exact, local, and independent of the
            // serialized neural narration queue. This avoids a word click
            // waiting behind a long page-generation job. Hosts without a
            // speech service fall through to the selected BookVoice voice.
            if (
                await pronounceWithSystemVoice(clean, langRef.current, {
                    narratorVoiceId: activeVoiceRef.current,
                })
            )
                return;
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
            if (!el) return;
            el.src = url;
            await el.play();
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
            const browsingAwayFromNarration =
                audioPageRef.current != null &&
                pageNumberRef.current !== audioPageRef.current;
            if (browsingAwayFromNarration) {
                try {
                    await pronounceWord(word, index);
                } catch (e) {
                    toast.error(e.message || 'Could not pronounce word');
                }
                return;
            }
            if (playing) {
                const t = wordTimesRef.current[index];
                if (typeof t === 'number' && t >= 0 && audioRef.current) {
                    seekTransportTo(t);
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
                await pronounceWord(word, index);
            } catch (e) {
                toast.error(e.message || 'Could not pronounce word');
            }
        },
        [cancelPrefetch, pronounceWord, seekTransportTo, setResumePoint, toast]
    );

    const handleTranslatePage = async () => {
        const text = pageTextRef.current || pageText;
        if (!text.trim()) return;
        const target = targetLanguage;
        try {
            setStatusHint('Translating…');
            const translated = await translateText(text, target);
            setPageText(translated);
            pageTextRef.current = translated;
            setPageWords(translated.split(/\s+/).filter(Boolean));
            pageWordsRef.current = translated.split(/\s+/).filter(Boolean);
            cachePageText(pageNumber, translated);
            if (libraryBookId) {
                await savePreparedPage(libraryBookId, pageNumber, translated, numPages || pageNumber);
            }
            cacheRef.current.clear();
            setAudioUrl(null);
            toast.success('Text translated — press Read to narrate.');
        } catch (e) {
            toast.error(e.message || 'Translation failed');
        } finally {
            setStatusHint('');
        }
    };

    const handleSaveEditedText = async () => {
        const text = editTextDraft.trim();
        if (!text) return;
        setPageText(text);
        pageTextRef.current = text;
        setPageWords(text.split(/\s+/).filter(Boolean));
        pageWordsRef.current = text.split(/\s+/).filter(Boolean);
        cachePageText(pageNumber, text);
        if (libraryBookId) {
            try {
                await savePreparedPage(libraryBookId, pageNumber, text, numPages || pageNumber);
            } catch (error) {
                toast.error(error.message || 'Could not save the edited page to this book.');
                return;
            }
        }
        cacheRef.current.clear();
        setAudioUrl(null);
        setIsEditingText(false);
        toast.info('Text updated — press Read to narrate.');
    };

    const activateBookFile = (f, book = null) => {
        if (!f) return;
        const preparedProfile = activePreparedProfile(book);
        cancelPrefetch();
        const nextDocumentId = documentFingerprint(f);
        const progress = loadReadingProgress(nextDocumentId);
        setDocumentId(nextDocumentId);
        setBookmarks(progress.bookmarks);
        savedResumeRef.current = { page: progress.page, time: progress.time };
        setTransportRate(progress.playbackRate);
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
        wordEndsRef.current = [];
        timingModeRef.current = 'estimate';
        segmentsRef.current = [];
        playlistRef.current = [];
        playlistIndexRef.current = 0;
        playlistExpectedTotalRef.current = 0;
        playlistWaitingRef.current = false;
        playlistShouldPlayRef.current = false;
        playlistSeekGenerationRef.current += 1;
        chunkPreloadsRef.current.clear();
        timelineRef.current = null;
        audioTimeOffsetRef.current = 0;
        cacheRef.current.clear();
        audioVoiceRef.current = null;
        setZoom(progress.zoom);
        setDisplayZoom(progress.zoom);
        setLibraryBookId(book?.id || null);
        setActiveProfileId(preparedProfile?.id || null);
        setPreparation(preparationForActiveProfile(book));
        if (preparedProfile) {
            const profileVoice = preparedProfile.voiceId ?? null;
            const profileLanguage = preparedProfile.languageId || 'en';
            setActiveVoiceId(profileVoice);
            activeVoiceRef.current = profileVoice;
            audioVoiceRef.current = profileVoice;
            setTargetLanguage(profileLanguage);
            langRef.current = profileLanguage;
        }
        clearPlaybackState();
        refreshTransport();
        onDirty?.();
    };

    const handlePrepareWholeBook = async () => {
        if (!libraryBookId || !numPages || !modelReady) {
            toast.error('Open a library book and wait for the voice model before preparing it.');
            return;
        }
        try {
            const manifest = await getPreparedBook(libraryBookId);
            const missingPages = missingPreparedTextPages(numPages, manifest.pageHashes);
            await mapWithConcurrency(
                missingPages,
                3,
                async (page) => {
                    const text = await preparePageText(page, { quiet: true });
                    await savePreparedPage(libraryBookId, page, text, numPages);
                },
                (completed, total) => setStatusHint(`Extracted ${completed} of ${total} pages…`)
            );
            if (!missingPages.length) setStatusHint('All page text is already prepared…');
            const job = await createBookPreparation(
                libraryBookId,
                activeVoiceRef.current,
                langRef.current
            );
            setPreparation(job);
            toast.success('Whole-book preparation started. Current-page actions stay prioritized.');
        } catch (error) {
            toast.error(error.message || 'Could not start whole-book preparation.');
        } finally {
            setStatusHint('');
        }
    };

    const handleCancelPreparation = async () => {
        if (!preparation?.id || isCancellingPreparation) return;
        setIsCancellingPreparation(true);
        try {
            const cancelled = await cancelBookPreparation(preparation.id);
            setPreparation((current) => ({ ...current, ...cancelled }));
            toast.success('Whole-book preparation cancelled.');
        } catch (error) {
            toast.error(error.message || 'Could not cancel whole-book preparation.');
        } finally {
            setIsCancellingPreparation(false);
        }
    };

    const handleCreatePreparedFile = async () => {
        if (!libraryBookId || !activeProfileId) return;
        try {
            const archive = await createBookArchive(libraryBookId, activeProfileId);
            const link = document.createElement('a');
            link.href = archive.downloadUrl;
            link.download = `${(file?.name || 'book').replace(/\.pdf$/i, '')}.bookvoice`;
            document.body.appendChild(link);
            link.click();
            link.remove();
        } catch (error) {
            toast.error(error.message || 'Could not create the prepared-book file.');
        }
    };

    const openLibraryBook = async (book) => {
        try {
            const source = await preparedBookSource(book.id);
            const pdf = new File([source], `${book.title || 'Prepared book'}.pdf`, {
                type: 'application/pdf',
                lastModified: Number(book.updatedAt || Date.now()) * 1000,
            });
            activateBookFile(pdf, book);
        } catch (error) {
            toast.error(error.message || 'Could not open the prepared book.');
        }
    };
    openLibraryBookRef.current = openLibraryBook;

    const handleFileChange = async (e) => {
        const selected = e.target.files[0];
        if (!selected) return;
        const isArchive = selected.name.toLowerCase().endsWith('.bookvoice');
        if (!isArchive) activateBookFile(selected, null);
        try {
            setStatusHint('Adding book to your library…');
            const book = await importPreparedBook(selected);
            setLibraryBooks(await listPreparedBooks());
            if (isArchive) {
                await openLibraryBook(book);
            } else {
                setLibraryBookId(book.id);
                setActiveProfileId(book.activeProfileId || book.profiles?.[0]?.id || null);
                setPreparation(book.preparation || null);
            }
        } catch (error) {
            if (isArchive) toast.error(error.message || 'Could not open this book.');
            else toast.error('The PDF is open, but it could not be added to the prepared library.');
        } finally {
            setStatusHint('');
            e.target.value = '';
        }
    };

    const handleSearch = async (event) => {
        event?.preventDefault?.();
        if (!searchQuery.trim() || !numPages) return;
        setIsSearching(true);
        try {
            const found = await findTextInDocument(searchQuery, pageNumber + 1);
            if (found) {
                await browsePageIntoView(found);
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

    // Plain wheel scrolls. Ctrl+wheel zooms. Pointer capture provides true
    // grab-and-drag panning without losing the drag when the cursor leaves.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const onWheel = (ev) => {
            if (!shouldZoomPdfWheel(ev)) return;
            ev.preventDefault();
            setZoom((current) => {
                const direction = ev.deltaY < 0 ? 1 : -1;
                return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current + direction * ZOOM_STEP));
            });
        };

        const onDown = (ev) => {
            if (zoom <= 1.02) return;
            if (ev.button !== 0) return;
            ev.preventDefault();
            el.setPointerCapture?.(ev.pointerId);
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
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            el.removeEventListener('pointerdown', onDown);
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerup', onUp);
            el.removeEventListener('pointercancel', onUp);
            el.removeEventListener('wheel', onWheel);
        };
    }, [zoom, file]);

    const getPlayButtonState = () => {
        if (isPlaying)
            return { text: ' Pause', disabled: false, icon: <Pause size={16} /> };
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
        if (shouldDisableNarrationStart({
            isPlaying,
            modelError,
            modelReady,
            isOcring,
            isGenerating,
        }))
            return {
                text: statusHint ? ` ${statusHint}` : ' Generating…',
                disabled: true,
                icon: <Loader2 className="spinner" size={16} />,
            };
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
        <div className="pdf-viewer-container" data-transport-state={transportState}>
            {!file ? (
                <div className="upload-state pdf-upload-state">
                    <input
                        type="file"
                        accept=".pdf,.bookvoice,application/pdf,application/zip"
                        onChange={handleFileChange}
                        id="pdf-upload"
                        className="file-input"
                    />
                    <div className="pdf-upload-card">
                        <p className="pdf-upload-eyebrow">Your reading room</p>
                        <h2>Start a listening session</h2>
                        <p className="pdf-upload-intro">
                            Open a text-based PDF to read and hear it in one place.
                        </p>
                        <label htmlFor="pdf-upload" className="btn primary">
                            Select PDF Book
                        </label>
                        <p className="pdf-upload-hint">
                            {deviceInfo === 'cpu'
                                ? 'Text is ready immediately. CPU narration is slower, so page prefetch stays off.'
                                : 'Your book stays local. Nearby pages warm in the background for seamless flipping.'}
                        </p>
                        {libraryBooks.length ? (
                            <div className="prepared-library">
                                <p className="prepared-library-title">Prepared library</p>
                                {libraryBooks.slice(0, 5).map((book) => {
                                    const details = preparedBookDetails(book);
                                    return (
                                        <button
                                            type="button"
                                            className="prepared-book-row"
                                            key={book.id}
                                            onClick={() => openLibraryBook(book)}
                                        >
                                            <span>{book.title}</span>
                                            <small>
                                                Continue page {details.resumePage} · {details.preparedPages}/{details.pageCount || '—'} narrated
                                                {details.bookmarks.length ? ` · Bookmarks ${details.bookmarks.join(', ')}` : ''}
                                            </small>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}
                    </div>
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
                                TTS is on CPU, so narration will be much slower than GPU mode.
                            </span>
                        </div>
                    )}
                    {prefetchHint && modelReady && !isGenerating && (
                        <div className="model-loading-status-bar prefetch">
                            <Loader2 className="spinner" size={12} />
                            <span>{prefetchHint}</span>
                        </div>
                    )}
                    <PreparationProgress
                        preparation={preparation}
                        onCancel={handleCancelPreparation}
                        cancelling={isCancellingPreparation}
                    />

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

                    <div className="reader-navigation" role="toolbar" aria-label="Reader navigation">
                        <button
                            className="btn secondary btn-compact"
                            onClick={() => goToPage(pageNumber - 1)}
                            disabled={pageNumber <= 1}
                            aria-label="Previous page"
                        >
                            <ChevronUp size={15} /> Previous
                        </button>
                        <form className="page-jump" onSubmit={handlePageJump}>
                            <label htmlFor="reader-page-input">Page</label>
                            <input
                                id="reader-page-input"
                                type="number"
                                min={1}
                                max={numPages || 1}
                                value={pageJumpInput}
                                onChange={(event) => setPageJumpInput(event.target.value)}
                                onBlur={handlePageJump}
                            />
                            <span>/ {numPages || '—'}</span>
                        </form>
                        <button
                            className="btn secondary btn-compact"
                            onClick={() => goToPage(pageNumber + 1)}
                            disabled={pageNumber >= numPages}
                            aria-label="Next page"
                        >
                            Next <ChevronDown size={15} />
                        </button>
                        {audioPage && audioPage !== pageNumber ? (
                            <button
                                type="button"
                                className="btn primary btn-compact"
                                onClick={() => browsePageIntoView(audioPage)}
                                aria-label={`Return to narrated page ${audioPage}`}
                            >
                                <LocateFixed size={15} /> Return to narrated page {audioPage}
                            </button>
                        ) : null}
              <div className="zoom-controls" title="Zoom with Ctrl+mouse wheel or these controls">
                            <button
                                type="button"
                                className="btn secondary btn-compact"
                                onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))}
                                aria-label="Zoom out"
                            >
                                <ZoomOut size={15} />
                            </button>
                            <span className="zoom-label" aria-label={`Zoom ${Math.round(zoom * 100)} percent`}>
                                {Math.round(zoom * 100)}%
                            </span>
                            <button
                                type="button"
                                className="btn secondary btn-compact"
                                onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
                                aria-label="Zoom in"
                            >
                                <ZoomIn size={15} />
                            </button>
                            <button
                                type="button"
                                className="btn secondary btn-compact"
                                onClick={() => setZoom(1)}
                                aria-label="Fit PDF to reading area"
                            >
                                <Maximize2 size={15} />
                            </button>
                        </div>
                        <label className="reader-follow">
                            <input
                                type="checkbox"
                                checked={followNarration}
                                onChange={(event) => setFollowNarration(event.target.checked)}
                            />
                            Follow narration
                        </label>
                        {pageNumber > 1 ? (
                            <button
                                type="button"
                                className="btn secondary btn-compact"
                                onClick={handleExportThroughCurrentPage}
                                disabled={isExporting}
                                title={`Export cached audio for pages 1 through ${pageNumber}`}
                            >
                                {isExporting ? <Loader2 className="spinner" size={15} /> : <Download size={15} />}
                                Export 1–{pageNumber}
                            </button>
                        ) : null}
                        <form className="page-search" onSubmit={handleSearch}>
                            <Search size={14} />
                            <input
                                type="search"
                                value={searchQuery}
                                onChange={(event) => setSearchQuery(event.target.value)}
                                placeholder="Find in book"
                                aria-label="Find text in book"
                            />
                            <button className="btn secondary btn-compact" disabled={!searchQuery.trim() || isSearching}>
                                {isSearching ? <Loader2 className="spinner" size={14} /> : 'Find'}
                            </button>
                        </form>
                        <button
                            type="button"
                            className="btn secondary btn-compact"
                            onClick={() => setBookmarks((items) => toggleBookmark(items, pageNumber))}
                            aria-label={bookmarks.includes(pageNumber) ? 'Remove bookmark' : 'Bookmark page'}
                        >
                            {bookmarks.includes(pageNumber) ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
                            {bookmarks.includes(pageNumber) ? `Bookmarked ${pageNumber}` : 'Bookmark'}
                        </button>
                        {bookmarks.length ? (
                            <select
                                className="bookmark-jump"
                                aria-label="Go to bookmark"
                                value=""
                                onChange={(event) => {
                                    if (event.target.value) goToPage(Number(event.target.value));
                                }}
                            >
                                <option value="">Bookmarks ({bookmarks.length})</option>
                                {bookmarks.map((page) => (
                                    <option key={page} value={page}>Page {page}</option>
                                ))}
                            </select>
                        ) : null}
                        <button
                            type="button"
                            className="btn secondary btn-compact reader-options-toggle"
                            onClick={() => setShowReadingOptions((open) => !open)}
                            aria-expanded={showReadingOptions}
                            aria-label="Reading options"
                        >
                            <SlidersHorizontal size={15} /> Reading options
                        </button>
                    </div>

                    {showReadingOptions ? (
                        <section className="reading-options" aria-label="Reading options panel">
                            <VoiceSettings
                                compact
                                backendReady={modelReady}
                                activeVoiceId={activeVoiceId}
                                onVoiceChange={handleVoiceChange}
                            />
                            <label className="reading-option-field">
                                Language
                                <select
                                    value={targetLanguage}
                                    onChange={(event) => handleLanguageChange(event.target.value)}
                                    disabled={isGenerating || isOcring}
                                >
                                    {SUPPORTED_LANGUAGES.map((lang) => (
                                        <option key={lang.code} value={lang.code}>{lang.name}</option>
                                    ))}
                                </select>
                            </label>
                            <button className="btn secondary btn-compact" onClick={handleForceOcr} disabled={isGenerating || isOcring}>
                                <ScanText size={15} /> {isOcring ? 'Running OCR…' : 'Re-run OCR'}
                            </button>
                            <button className="btn secondary btn-compact" onClick={() => { setEditTextDraft(pageText); setIsEditingText((value) => !value); }} disabled={!pageText}>
                                {isEditingText ? 'Cancel editing' : 'Edit extracted text'}
                            </button>
                            <button className="btn secondary btn-compact" onClick={handleTranslatePage} disabled={!pageText || isGenerating}>
                                Translate to {targetLanguage === 'ar' ? 'Arabic' : 'English'}
                            </button>
                            <button className="btn primary btn-compact" onClick={handlePrepareWholeBook} disabled={!modelReady || !libraryBookId || preparation?.status === 'RUNNING'}>
                                Prepare whole book
                            </button>
                            {activeProfileId ? (
                                <button className="btn secondary btn-compact" onClick={handleCreatePreparedFile}>
                                    <Download size={15} /> Save .bookvoice file
                                </button>
                            ) : null}
                        </section>
                    ) : null}

                    <div className="pdf-layout">
                        <div className="pdf-main">
                            <h3 className="reader-section-label">Original PDF</h3>
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
                                        loadPageIntoView(restoredPage, { autoplay: false });
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
                                            zoom: displayZoom,
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
                                    Translate to {targetLanguage === 'ar' ? 'Arabic' : 'English'}
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
                                currentWord={audioPage === pageNumber ? currentWord : -1}
                                isPlaying={audioPage === pageNumber && isPlaying}
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
                                followNarration={followNarration}
                            />
                            )}
                        </div>
                    </div>

                    <div className="pdf-toolbar" role="region" aria-label="Narration player">
                        <div className="pdf-toolbar-controls">
                            <PlaybackControls
                                transport={{ ...transport, isPlaying }}
                                onToggle={handlePlay}
                                onStop={stopPlayback}
                                disabled={playBtn.disabled}
                                generating={isGenerating}
                                hasMedia={!!audioRef.current?.src || !!audioUrl}
                                pageLabel={
                                    audioPage
                                        ? `Narrating page ${audioPage}`
                                        : `Viewing page ${pageNumber} of ${numPages || '?'}`
                                }
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
                        </div>
                    </div>
                </>
            )}
            <audio ref={audioRef} style={{ display: 'none' }} preload="auto" />
            <audio ref={pronounceRef} style={{ display: 'none' }} preload="auto" />
        </div>
    );
}
