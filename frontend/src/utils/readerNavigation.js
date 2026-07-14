/**
 * Browsing away from live narration must never pull the reader back or
 * interrupt playback. Leave follow mode alone when returning to the audio
 * page or when audio is paused.
 */
export function shouldDisableFollowNarration({ isPlaying, narratedPage, targetPage }) {
    return Boolean(isPlaying && narratedPage != null && narratedPage !== targetPage);
}
