const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api';
const AUDIO_BASE_URL = import.meta.env.VITE_AUDIO_BASE_URL || 'http://localhost:8000';

export async function narrateText(text, sessionId, pageIndex, voiceId = null) {
    const requestBody = {
        text,
        session_id: sessionId,
        page_index: pageIndex
    };
    
    if (voiceId) {
        requestBody.voice_id = voiceId;
    }

    const response = await fetch(`${API_BASE_URL}/tts/narrate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to narrate text');
    }

    const data = await response.json();
    return `${AUDIO_BASE_URL}${data.audio_url}`;
}

export async function getVoices() {
    const response = await fetch(`${API_BASE_URL}/voices/`);
    if (!response.ok) {
        throw new Error("Failed to fetch voices");
    }
    const data = await response.json();
    return data.voices;
}

export async function uploadVoice(audioBlob, name) {
    const formData = new FormData();
    formData.append("file", audioBlob, `${name}.wav`);
    formData.append("name", name);
    
    const response = await fetch(`${API_BASE_URL}/voices/`, {
        method: 'POST',
        body: formData
    });
    
    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Failed to upload voice");
    }
    
    return await response.json();
}
