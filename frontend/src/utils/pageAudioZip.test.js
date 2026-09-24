import { describe, expect, it, vi } from 'vitest';
import {
    buildPageAudioZip,
    createPageAudioManifest,
    createSinglePageDownload,
    createStoredZip,
} from './pageAudioZip';

function signatures(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const found = [];
    for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
        const signature = view.getUint32(offset, true);
        if ([0x04034b50, 0x02014b50, 0x06054b50].includes(signature)) {
            found.push({ signature, offset });
        }
    }
    return found;
}

describe('createStoredZip', () => {
    it('writes local entries and a central directory without compression', () => {
        const zip = createStoredZip([{ name: 'note.txt', data: 'hello' }], new Date('2026-01-02T03:04:06Z'));
        const view = new DataView(zip.buffer);

        expect(view.getUint32(0, true)).toBe(0x04034b50);
        expect(view.getUint16(8, true)).toBe(0);
        expect(signatures(zip).map(({ signature }) => signature)).toEqual([
            0x04034b50,
            0x02014b50,
            0x06054b50,
        ]);
    });
});

describe('page audio downloads', () => {
    it('passes a single prepared WAV URL through with a stable filename', () => {
        const result = createSinglePageDownload({
            bookTitle: 'My Book.pdf',
            page: 7,
            audioUrl: '/audio/page-7.wav',
        });

        expect(result).toEqual({
            downloadUrl: '/audio/page-7.wav',
            filename: 'My Book-page-7.wav',
        });
    });

    it('builds a range ZIP with page WAVs, progress, and manifest content', async () => {
        const fetchImpl = vi.fn(async (url) => ({
            ok: true,
            blob: async () => new Blob([url]),
        }));
        const onProgress = vi.fn();

        const zip = await buildPageAudioZip({
            bookTitle: 'Reader Book',
            pages: [
                { page: 2, audioUrl: '/audio/two.wav' },
                { page: 3, audioUrl: '/audio/three.wav' },
            ],
            startPage: 2,
            endPage: 3,
            onProgress,
            fetchImpl,
            exportedAt: new Date('2026-09-23T12:00:00.000Z'),
        });

        const decoded = new TextDecoder().decode(zip);
        expect(fetchImpl).toHaveBeenNthCalledWith(1, '/audio/two.wav');
        expect(fetchImpl).toHaveBeenNthCalledWith(2, '/audio/three.wav');
        expect(onProgress).toHaveBeenNthCalledWith(1, { current: 1, total: 2, page: 2 });
        expect(onProgress).toHaveBeenNthCalledWith(2, { current: 2, total: 2, page: 3 });
        expect(decoded).toContain('page-2.wav');
        expect(decoded).toContain('page-3.wav');
        expect(decoded).toContain('manifest.json');

        const manifestLength = new TextEncoder().encode(JSON.stringify(
            createPageAudioManifest('Reader Book', 2, 3, new Date('2026-09-23T12:00:00.000Z')),
            null,
            2,
        )).length;
        const centralDirectoryLength = (3 * 46) + 'page-2.wav'.length + 'page-3.wav'.length + 'manifest.json'.length;
        const manifestStart = zip.length - 22 - centralDirectoryLength - manifestLength;
        const manifestText = new TextDecoder().decode(zip.slice(manifestStart, manifestStart + manifestLength));
        expect(JSON.parse(manifestText)).toEqual({
            bookTitle: 'Reader Book',
            pageCount: 2,
            startPage: 2,
            endPage: 3,
            exportedAt: '2026-09-23T12:00:00.000Z',
        });
        expect(signatures(zip).map(({ signature }) => signature)).toEqual([
            0x04034b50,
            0x04034b50,
            0x04034b50,
            0x02014b50,
            0x02014b50,
            0x02014b50,
            0x06054b50,
        ]);
    });
});
