export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || `${window.location.origin}/api`;
export const AUDIO_BASE_URL = import.meta.env.VITE_AUDIO_BASE_URL || `${window.location.origin}`;

function detailMessage(errorData, fallback) {
    const detail = errorData?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
        return detail.map((d) => d.msg || JSON.stringify(d)).join('; ');
    }
    return fallback;
}

export async function narrateText(text, sessionId, pageIndex, voiceId = null, languageId = 'en') {
    const requestBody = {
        text,
        session_id: sessionId,
        page_index: pageIndex,
        language_id: languageId,
    };

    if (voiceId) {
        requestBody.voice_id = voiceId;
    }

    const response = await fetch(`${API_BASE_URL}/tts/narrate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(detailMessage(error, 'Failed to narrate text'));
    }

    const data = await response.json();
    return `${AUDIO_BASE_URL}${data.audio_url}`;
}

export async function getVoices() {
    const response = await fetch(`${API_BASE_URL}/voices/`);
    if (!response.ok) {
        throw new Error('Failed to fetch voices');
    }
    const data = await response.json();
    return data.voices;
}

export async function uploadVoice(audioBlob, name) {
    const formData = new FormData();
    const filename = name.endsWith('.wav') ? name : `${name}.wav`;
    formData.append('file', audioBlob, filename);
    formData.append('name', name);

    const response = await fetch(`${API_BASE_URL}/voices/`, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(detailMessage(errorData, 'Failed to upload voice'));
    }

    return await response.json();
}

export async function translateText(text, targetLang) {
    const response = await fetch(`${API_BASE_URL}/translate/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            text,
            target_lang: targetLang,
        }),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(detailMessage(errorData, 'Failed to translate text'));
    }

    const data = await response.json();
    return data.translated_text;
}

export async function getTtsStatus() {
    const response = await fetch(`${API_BASE_URL}/tts/status`);
    if (!response.ok) {
        throw new Error('Failed to fetch TTS status');
    }
    return response.json();
}

export async function reloadTtsModel() {
    const response = await fetch(`${API_BASE_URL}/tts/reload`, { method: 'POST' });
    if (!response.ok) {
        throw new Error('Failed to reload the TTS model');
    }
    return response.json();
}

export async function getUserConfig() {
    const response = await fetch(`${API_BASE_URL}/config/`);
    if (!response.ok) {
        throw new Error('Failed to fetch config');
    }
    return response.json(); // { version, config }
}

export async function saveUserConfig(partial) {
    const response = await fetch(`${API_BASE_URL}/config/`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(detailMessage(errorData, 'Failed to save config'));
    }
    return response.json();
}

export async function extractTextFromImageApi(imageSrc) {
    const response = await fetch(`${API_BASE_URL}/ocr`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image_data: imageSrc }),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(detailMessage(errorData, 'Failed to process image OCR on the server.'));
    }

    const data = await response.json();
    return data.text;
}
