import { useCallback, useRef } from 'react';
import { useAudioTransport } from '../useAudioTransport';

/**
 * Reader transport with optional playlist timeline.
 *
 * Wraps `useAudioTransport` so the consumer can install a *timeline*
 * (an object with `getCurrentTime(audio)`, `getDuration()`, and
 * `seekTo(seconds, audio)`) that maps between the audio element's local
 * time and the global playlist time. When the timeline is installed the
 * transport's `currentTime`, `duration`, and `seekTo` all read/write
 * global time; when it's cleared the transport falls back to the raw
 * audio element.
 *
 * The original PdfViewer installed/cleared the timeline inline on every
 * playlist change. This hook makes the lifecycle explicit:
 *
 *   const transport = useReaderTransport(audioRef);
 *   // When a chunked TTS stream starts:
 *   transport.installPlaylistTimeline(timeline);
 *   // When the playlist is cleared (page change, stop, voice switch):
 *   transport.clearPlaylistTimeline();
 *
 * @param {React.MutableRefObject<HTMLAudioElement|null>} audioRef
 * @returns {{
 *   isPlaying: boolean,
 *   currentTime: number,
 *   duration: number,
 *   playbackRate: number,
 *   mediaError: string,
 *   toggle: () => Promise<boolean>,
 *   seekTo: (seconds: number) => number | undefined,
 *   skipBy: (seconds: number) => number | undefined,
 *   cycleRate: () => void,
 *   setRate: (rate: number) => void,
 *   refresh: () => void,
 *   installPlaylistTimeline: (timeline: object | null) => void,
 *   clearPlaylistTimeline: () => void,
 * }}
 */
export function useReaderTransport(audioRef) {
    const timelineRef = useRef(null);
    const transport = useAudioTransport(audioRef, timelineRef);

    const installPlaylistTimeline = useCallback((timeline) => {
        timelineRef.current = timeline || null;
    }, []);

    const clearPlaylistTimeline = useCallback(() => {
        timelineRef.current = null;
    }, []);

    return {
        ...transport,
        installPlaylistTimeline,
        clearPlaylistTimeline,
    };
}
