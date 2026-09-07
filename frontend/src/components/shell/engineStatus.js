/**
 * One honest waiting story for the whole app: derive the top-bar chip state
 * from the TTS status poll so every view shows the same engine progress
 * instead of each button inventing its own wording.
 */
export function engineStatusFromTts({ modelReady, modelError, modelStatusDetail }) {
    if (modelError) {
        return { tone: 'is-error', label: 'Engine error', detail: modelError };
    }
    if (modelReady) {
        return { tone: 'is-ready', label: 'Voices ready', detail: modelStatusDetail || 'Voices ready' };
    }
    return {
        tone: 'is-warming',
        label: 'Warming up…',
        detail: modelStatusDetail || 'The narration voices are warming up.',
    };
}
