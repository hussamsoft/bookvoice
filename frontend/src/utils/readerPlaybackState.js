export function shouldDisableNarrationStart({
    isPlaying,
    modelError,
    modelReady,
    isOcring,
    isGenerating,
    hasPreparedAudio = false,
}) {
    return Boolean(
        !isPlaying && (isOcring || isGenerating || (!hasPreparedAudio && (modelError || !modelReady)))
    );
}
