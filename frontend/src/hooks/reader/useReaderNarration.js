import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelGeneration, narrateTextStream } from '../../utils/api';
import { cacheKey, createPageAudioCache } from '../../utils/pageAudioCache';
import { preparedPageAudioEntry } from '../../utils/pageContentResolver';
import {
    buildPlaylist,
    globalTimeForChunk,
    nextChunkIndex,
    playbackTargetAtGlobalTime,
} from '../../utils/playlistController';
import { waitForAudioMetadata } from '../../utils/media';

/**
 * Page narration for the migrated reader: streaming TTS with gapless
 * chunk advance, prepared single-audio playback, a small page-audio
 * cache, cancel-on-navigate, and the one-shot resume seek.
 *
 * This is the A.8.2 port of PdfViewer's playback core. Word highlighting,
 * pause-pronunciation, prefetch, voice pickers, and translation are later
 * slices: cache entries carry empty timing arrays (timingMode
 * 'estimate'), which keeps the entry shape a highlighting slice can fill
 * in without reworking this hook.
 *
 * Voice/language are plain args (mirrored into refs internally); `null`
 * voiceId is a supported configuration — the server narrates with its
 * default voice.
 *
 * @param {object} args
 * @param {React.MutableRefObject<HTMLAudioElement|null>} args.audioRef
 * @param {object} args.transport      `useReaderTransport` result.
 * @param {string} args.sessionId      Stable per-reader session id.
 * @param {string|null} [args.voiceId]
 * @param {string} [args.languageId='en']
 * @param {boolean} [args.modelReady]  TTS model readiness gate.
 * @param {() => number} args.getPage  Current page (1-indexed).
 * @param {(page: number) => void} args.onNarratePage
 *   Fresh-narration escape hatch: resolves the page and comes back
 *   through `startForLoadedPage` (Reader wires this to
 *   `lifecycle.loadPage(page, { autoplay: true })`).
 * @param {object} args.toast          `{ error }`.
 */
export function useReaderNarration({
    audioRef,
    transport,
    sessionId,
    voiceId = null,
    languageId = 'en',
    modelReady = false,
    getPage,
    onNarratePage,
    toast,
}) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [transportState, setTransportState] = useState('idle');
    const [audioPage, setAudioPage] = useState(null);
    const [muted, setMutedState] = useState(false);

    // Playlist state (see PdfViewer's streaming port): the collected
    // chunk events, the playing position inside them, and the intent
    // flags that decide what "ended" means mid-generation.
    const playlistRef = useRef([]);
    const playlistIndexRef = useRef(0);
    const playlistExpectedTotalRef = useRef(0);
    const playlistWaitingRef = useRef(false);
    const playlistShouldPlayRef = useRef(false);
    const playlistSeekGenerationRef = useRef(0);
    const audioTimeOffsetRef = useRef(0);
    const streamAbortRef = useRef(null);
    const requestSeqRef = useRef(0);
    const cacheRef = useRef(createPageAudioCache({ maxEntries: 14 }));
    const savedResumeRef = useRef({ page: 0, time: 0 });
    const audioUrlRef = useRef(null);

    // Mirrors so the once-bound audio handlers and the timeline read the
    // latest values without re-binding.
    const isPlayingRef = useRef(false);
    const isGeneratingRef = useRef(false);
    const transportStateRef = useRef('idle');
    const voiceIdRef = useRef(voiceId);
    const languageIdRef = useRef(languageId);
    const modelReadyRef = useRef(modelReady);
    useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
    useEffect(() => { isGeneratingRef.current = isGenerating; }, [isGenerating]);
    useEffect(() => { transportStateRef.current = transportState; }, [transportState]);
    useEffect(() => { voiceIdRef.current = voiceId; }, [voiceId]);
    useEffect(() => { languageIdRef.current = languageId; }, [languageId]);
    useEffect(() => { modelReadyRef.current = modelReady; }, [modelReady]);
    useEffect(() => {
        const audio = audioRef.current;
        if (audio) audio.muted = muted;
    }, [muted, audioRef]);

    const setTransport = useCallback((state) => {
        transportStateRef.current = state;
        setTransportState(state);
    }, []);

    const clearPlaylist = useCallback(() => {
        playlistRef.current = [];
        playlistIndexRef.current = 0;
        playlistExpectedTotalRef.current = 0;
        playlistWaitingRef.current = false;
        playlistShouldPlayRef.current = false;
        audioTimeOffsetRef.current = 0;
    }, []);

    const advancePlaylistRef = useRef(null);
    const seekPlaylistGlobalRef = useRef(null);

    // The timeline maps the audio element's chunk-local time to the
    // page's global time while a stream owns the player.
    const playlistTimeline = useRef({
        getCurrentTime: (media) => globalTimeForChunk(
            buildPlaylist(playlistRef.current),
            playlistIndexRef.current,
            Number(media?.currentTime) || 0,
        ),
        getDuration: () => buildPlaylist(playlistRef.current).totalDurationS,
        seekTo: (target, media) => seekPlaylistGlobalRef.current?.(target, media),
    });

    seekPlaylistGlobalRef.current = (targetSeconds, media) => {
        if (!media) return;
        const target = playbackTargetAtGlobalTime(buildPlaylist(playlistRef.current), targetSeconds);
        playlistSeekGenerationRef.current += 1;
        if (!target) {
            media.currentTime = Math.max(0, Number(targetSeconds) || 0);
            return;
        }
        playlistIndexRef.current = target.chunkIndex;
        audioTimeOffsetRef.current = Number(target.chunk.start_s) || 0;
        media.src = target.chunk.url;
        media.currentTime = target.localTime;
        if (playlistShouldPlayRef.current) {
            Promise.resolve(media.play()).catch(() => {});
        }
    };

    advancePlaylistRef.current = async () => {
        const audio = audioRef.current;
        if (!audio) return false;
        const playlist = buildPlaylist(playlistRef.current);
        const next = nextChunkIndex(playlist, playlistIndexRef.current);
        if (next == null || !playlist.chunks[next]) return false;
        playlistIndexRef.current = next;
        const chunk = playlist.chunks[next];
        audioTimeOffsetRef.current = Number(chunk.start_s) || 0;
        audio.src = chunk.url;
        audio.currentTime = 0;
        transport.refresh();
        if (playlistShouldPlayRef.current) {
            try { await audio.play(); } catch { /* play rejection surfaces via media error */ }
        }
        return true;
    };

    const applyReadyAudio = useCallback(async (entry, { autoplay = false } = {}) => {
        const audio = audioRef.current;
        if (!audio || !entry?.audioUrl) return;
        clearPlaylist();
        transport.clearPlaylistTimeline();
        audioUrlRef.current = entry.audioUrl;
        audio.src = entry.audioUrl;
        setTransport('buffering');
        try {
            await waitForAudioMetadata(audio);
        } catch (error) {
            setTransport('idle');
            toast.error(error?.message || 'Audio could not be loaded.');
            return;
        }
        let seekTime = 0;
        // One-shot resume: park the playhead at the saved position the
        // first time the restored page gets audio (browse included —
        // autoplay stays false, so it never speaks on its own).
        if (savedResumeRef.current.page === Number(entry.page) && savedResumeRef.current.time > 0) {
            seekTime = Math.min(savedResumeRef.current.time, audio.duration || Infinity);
            savedResumeRef.current = { page: 0, time: 0 };
        }
        audio.currentTime = seekTime;
        if (autoplay) {
            try {
                await audio.play();
                return; // 'play' event flips state to playing
            } catch { /* rejection surfaces through the media error path */ }
        }
        setTransport('paused');
    }, [audioRef, clearPlaylist, setTransport, toast, transport]);

    const generateAndPlayStreamed = useCallback(async (page, text, { autoplay = true } = {}) => {
        const audio = audioRef.current;
        if (!audio) return;
        streamAbortRef.current?.abort();
        const controller = new AbortController();
        streamAbortRef.current = controller;

        clearPlaylist();
        playlistShouldPlayRef.current = Boolean(autoplay);
        transport.installPlaylistTimeline(playlistTimeline.current);
        setTransport('buffering');
        setIsGenerating(true);

        const collected = [];
        let doneEvent = null;
        try {
            const finalEvent = await narrateTextStream(
                text,
                sessionId,
                page,
                voiceIdRef.current,
                languageIdRef.current || 'en',
                {
                    bookId: null,
                    // crypto.randomUUID is unavailable in some webviews
                    // (and jsdom); a monotonic id is all the server needs.
                    requestId: `${sessionId}-${page}-${requestSeqRef.current += 1}`,
                    onChunk: async (event) => {
                        if (event?.type === 'chunk') {
                            collected.push(event);
                            playlistRef.current = collected;
                            playlistExpectedTotalRef.current = Number(event.total) || 0;
                        } else if (event?.type === 'done') {
                            doneEvent = event;
                        }
                    },
                },
                controller.signal,
            );
            if (controller.signal.aborted) return;
            if (!doneEvent && finalEvent?.type === 'done') doneEvent = finalEvent;
            if (!doneEvent) {
                // Cancelled or errored server-side; abort paths already
                // reset state.
                setTransport('idle');
                return;
            }

            const words = String(text || '').split(/\s+/).filter(Boolean);
            const entry = {
                status: 'ready',
                page,
                voiceId: voiceIdRef.current ?? null,
                languageId: languageIdRef.current || 'en',
                audioUrl: doneEvent.audio_url || doneEvent.audioUrl,
                text,
                words,
                times: [],
                ends: [],
                segments: Array.isArray(doneEvent.segments) ? doneEvent.segments : [],
                duration_s: Number(doneEvent.duration_s) || 0,
                fromWord: 0,
                partial: false,
                timingMode: 'estimate',
            };
            cacheRef.current.set(cacheKey(page, voiceIdRef.current, languageIdRef.current), entry);

            // Promote the canonical full-page WAV at the current logical
            // position so the scrubber and duration become exact. The
            // play intent survives the swap — clearPlaylist() must NOT
            // be used here, it resets playlistShouldPlayRef.
            const logicalTime = transport.currentTime;
            playlistRef.current = [];
            playlistIndexRef.current = 0;
            playlistExpectedTotalRef.current = 0;
            playlistWaitingRef.current = false;
            audioTimeOffsetRef.current = 0;
            transport.clearPlaylistTimeline();
            audioUrlRef.current = entry.audioUrl;
            audio.src = entry.audioUrl;
            await waitForAudioMetadata(audio);
            const duration = Number(entry.duration_s) || audio.duration || 0;
            if (logicalTime > 0) audio.currentTime = Math.min(logicalTime, duration);
            if (playlistShouldPlayRef.current && duration - logicalTime > 0.01) {
                try { await audio.play(); } catch { /* media error path */ }
            } else {
                playlistShouldPlayRef.current = false;
                setTransport('paused');
            }
        } finally {
            setIsGenerating(false);
        }
    }, [audioRef, clearPlaylist, sessionId, setTransport, transport]);

    const generateAndPlay = useCallback(async (page, text, { autoplay = true } = {}) => {
        try {
            await generateAndPlayStreamed(page, text, { autoplay });
        } catch (error) {
            if (error?.name === 'AbortError') return;
            setTransport('idle');
            toast.error(error?.message || 'Could not generate audio for this page.');
        } finally {
            setIsGenerating(false);
        }
    }, [generateAndPlayStreamed, setTransport, toast]);

    // The ladder run from `onContent` for kind === 'load': prepared page
    // audio first, then the session cache, then generation (only on an
    // explicit play — browsing parks cached audio silently).
    const startForLoadedPage = useCallback(async (page, text, prepared, { autoplay = false } = {}) => {
        const preparedEntry = preparedPageAudioEntry({
            prepared,
            text,
            page,
            voiceId: voiceIdRef.current,
            languageId: languageIdRef.current,
        });
        if (preparedEntry) {
            setAudioPage(page);
            await applyReadyAudio(preparedEntry, { autoplay });
            return;
        }
        const key = cacheKey(page, voiceIdRef.current, languageIdRef.current);
        if (cacheRef.current.hasReady(key)) {
            setAudioPage(page);
            await applyReadyAudio(cacheRef.current.get(key), { autoplay });
            return;
        }
        if (!autoplay) return;
        if (!modelReadyRef.current) {
            toast.error('The voice model is still loading — try again in a moment.');
            return;
        }
        setAudioPage(page);
        await generateAndPlay(page, text, { autoplay });
    }, [applyReadyAudio, generateAndPlay, toast]);

    const pauseAudio = useCallback(() => {
        const audio = audioRef.current;
        playlistShouldPlayRef.current = false;
        playlistWaitingRef.current = false;
        if (audio && !audio.paused) audio.pause();
    }, [audioRef]);

    // The play/pause ladder: toggle → resume a stream mid-generation →
    // resume same-page audio → narrate the visible page.
    const handlePlay = useCallback(async () => {
        const audio = audioRef.current;
        if (!audio) return;
        if (playlistWaitingRef.current && isPlayingRef.current) {
            pauseAudio();
            return;
        }
        if (!audio.paused && !audio.ended) {
            pauseAudio();
            return;
        }
        if (playlistRef.current.length) {
            playlistShouldPlayRef.current = true;
            const advanced = await advancePlaylistRef.current();
            if (!advanced) {
                playlistWaitingRef.current = true;
                setTransport('buffering');
            }
            return;
        }
        if (audioUrlRef.current && audioPage != null && audioPage === getPage()) {
            try { await audio.play(); } catch { /* media error path */ }
            return;
        }
        onNarratePage(getPage());
    }, [audioPage, audioRef, getPage, onNarratePage, pauseAudio, setTransport]);

    const stopPlayback = useCallback(() => {
        streamAbortRef.current?.abort();
        streamAbortRef.current = null;
        cancelGeneration();
        clearPlaylist();
        transport.clearPlaylistTimeline();
        const audio = audioRef.current;
        if (audio) {
            if (!audio.paused) audio.pause();
            audio.currentTime = 0;
        }
        setIsPlaying(false);
        setTransport('stopped');
    }, [audioRef, clearPlaylist, setTransport, transport]);

    // Page loads for narration tear the current playback down before the
    // new page resolves: abort the stream, tell the server to stop
    // generating, and silence the player.
    const teardownForNavigation = useCallback(() => {
        streamAbortRef.current?.abort();
        streamAbortRef.current = null;
        cancelGeneration();
        clearPlaylist();
        transport.clearPlaylistTimeline();
        const audio = audioRef.current;
        if (audio && !audio.paused) audio.pause();
        setIsGenerating(false);
        setTransport('idle');
    }, [audioRef, clearPlaylist, setTransport, transport]);

    // Swapping books: stop everything, drop cached audio, and arm the
    // one-shot resume from the freshly loaded progress record.
    const resetForNewBook = useCallback((resumePage = 0, resumeTime = 0) => {
        stopPlayback();
        cacheRef.current.clear();
        audioUrlRef.current = null;
        setAudioPage(null);
        savedResumeRef.current = { page: resumePage, time: resumeTime };
    }, [stopPlayback]);

    const toggleMute = useCallback(() => setMutedState((current) => !current), []);

    // Audio events: playing/paused bookkeeping, gapless chunk advance on
    // ended, and the buffering hold when the next chunk is not ready yet.
    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return undefined;
        const onPlay = () => {
            playlistWaitingRef.current = false;
            setIsPlaying(true);
            setTransport('playing');
        };
        const onPause = () => {
            setIsPlaying(false);
            if (!playlistWaitingRef.current) setTransport('paused');
        };
        const onEnded = () => {
            advancePlaylistRef.current().then((advanced) => {
                if (advanced) return;
                if (isGeneratingRef.current
                    && playlistIndexRef.current + 1 < playlistExpectedTotalRef.current) {
                    // Play intent held: more chunks are on the way.
                    playlistWaitingRef.current = true;
                    setIsPlaying(true);
                    setTransport('buffering');
                    return;
                }
                playlistShouldPlayRef.current = false;
                setIsPlaying(false);
                setTransport('stopped');
            });
        };
        audio.addEventListener('play', onPlay);
        audio.addEventListener('pause', onPause);
        audio.addEventListener('ended', onEnded);
        return () => {
            audio.removeEventListener('play', onPlay);
            audio.removeEventListener('pause', onPause);
            audio.removeEventListener('ended', onEnded);
        };
    }, [audioRef, setTransport]);

    // Unmount: abort any in-flight generation and stop the player
    // (PdfViewer leaks this; the port closes the gap).
    useEffect(() => () => {
        streamAbortRef.current?.abort();
        cancelGeneration();
        const audio = audioRef.current;
        if (audio) audio.pause();
    }, [audioRef]);

    const scrubberDuration = playlistRef.current.length
        ? buildPlaylist(playlistRef.current).totalDurationS
        : transport.duration;

    return {
        isPlaying,
        isGenerating,
        transportState,
        audioPage,
        muted,
        scrubberDuration,
        handlePlay,
        stopPlayback,
        toggleMute,
        startForLoadedPage,
        teardownForNavigation,
        resetForNewBook,
    };
}
