export function shouldDisableNarrationStart({
    isPlaying,
    modelError,
    modelReady,
    isOcring,
    isGenerating,
}) {
    return Boolean(
        !isPlaying && (modelError || !modelReady || isOcring || isGenerating)
    );
}
