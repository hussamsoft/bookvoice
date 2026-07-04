const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api';
const AUDIO_BASE_URL = import.meta.env.VITE_AUDIO_BASE_URL || 'http://localhost:8000';

export async function narrateText(text, sessionId, pageIndex) {
    const response = await fetch(`${API_BASE_URL}/tts/narrate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            text,
            session_id: sessionId,
            page_index: pageIndex
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to narrate text');
    }

    const data = await response.json();
    return `${AUDIO_BASE_URL}${data.audio_url}`;
}
