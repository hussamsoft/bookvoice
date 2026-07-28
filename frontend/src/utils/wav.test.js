import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeWav, recordStreamToWav } from './wav';

const originalAudioContext = window.AudioContext;

afterEach(() => {
    window.AudioContext = originalAudioContext;
    vi.restoreAllMocks();
});

async function wavView(blob) {
    return new DataView(await blob.arrayBuffer());
}

describe('WAV recording quality', () => {
    it('writes the requested PCM sample rate without changing sample count', async () => {
        const samples = new Float32Array([0, 0.25, -0.5, 0.9]);

        const blob = encodeWav(samples, 48000);
        const view = await wavView(blob);

        expect(view.getUint32(24, true)).toBe(48000);
        expect(view.getUint16(34, true)).toBe(16);
        expect(view.getUint32(40, true)).toBe(samples.length * 2);
        expect(blob.size).toBe(44 + samples.length * 2);
    });

    it('preserves the browser native rate instead of decimating to 22.05 kHz', async () => {
        let processor;
        const source = { connect: vi.fn(), disconnect: vi.fn() };
        const gain = { gain: { value: 1 }, connect: vi.fn() };

        class FakeAudioContext {
            constructor(options) {
                this.options = options;
                this.sampleRate = 48000;
                this.state = 'running';
                this.destination = {};
            }

            createMediaStreamSource() {
                return source;
            }

            createScriptProcessor() {
                processor = {
                    connect: vi.fn(),
                    disconnect: vi.fn(),
                    onaudioprocess: null,
                };
                return processor;
            }

            createGain() {
                return gain;
            }

            close = vi.fn().mockResolvedValue(undefined);
        }

        window.AudioContext = FakeAudioContext;
        const recorder = await recordStreamToWav({}, { maxSeconds: 30 });
        const input = Float32Array.from({ length: 4096 }, (_value, index) => (
            Math.sin((2 * Math.PI * 8000 * index) / 48000) * 0.5
        ));
        processor.onaudioprocess({
            inputBuffer: { getChannelData: () => input },
        });

        const blob = await recorder.stop();
        const view = await wavView(blob);

        expect(recorder.sampleRate).toBe(48000);
        expect(view.getUint32(24, true)).toBe(48000);
        expect(view.getUint32(40, true)).toBe(input.length * 2);
        expect(blob.size).toBe(44 + input.length * 2);
    });
});
