/**
 * Encode Float32 mono PCM samples into a standard PCM WAV Blob.
 * Used so microphone recordings are real .wav files Chatterbox can load.
 */
export function encodeWav(samples, sampleRate = 22050) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples.length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
    }
}

/**
 * Record from a MediaStream into a true PCM WAV blob using Web Audio API.
 * Avoids MediaRecorder's webm/opus containers that break voice cloning.
 */
export async function recordStreamToWav(stream, { maxSeconds = 30, onLevel } = {}) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioCtx();
    const source = audioContext.createMediaStreamSource(stream);
    const sampleRate = audioContext.sampleRate;

    // ScriptProcessor is deprecated but widely supported; sufficient for short clips.
    const bufferSize = 4096;
    const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
    const chunks = [];
    let stopped = false;

    processor.onaudioprocess = (event) => {
        if (stopped) return;
        const input = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(input));
        if (onLevel) {
            let sum = 0;
            for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
            onLevel(Math.sqrt(sum / input.length));
        }
    };

    // Keep the graph alive without routing mic audio to speakers (avoids echo).
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(audioContext.destination);

    const stop = async () => {
        if (stopped) return encodeChunks();
        stopped = true;
        try {
            processor.disconnect();
            source.disconnect();
        } catch {
            /* ignore */
        }
        try {
            await audioContext.close();
        } catch {
            /* ignore */
        }
        return encodeChunks();
    };

    // Auto-stop safety
    const timer = setTimeout(() => {
        stop();
    }, maxSeconds * 1000);

    function encodeChunks() {
        clearTimeout(timer);
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Float32Array(total);
        let offset = 0;
        for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
        }
        // Downsample to 22050 if needed for smaller files
        const targetRate = 22050;
        const resampled =
            sampleRate === targetRate ? merged : downsample(merged, sampleRate, targetRate);
        return encodeWav(resampled, targetRate);
    }

    return { stop, sampleRate };
}

function downsample(buffer, fromRate, toRate) {
    if (toRate === fromRate) return buffer;
    const ratio = fromRate / toRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
        const idx = Math.floor(i * ratio);
        result[i] = buffer[idx];
    }
    return result;
}
