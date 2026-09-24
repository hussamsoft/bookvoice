const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
        crc ^= bytes[index];
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    };
}

function concatBytes(parts) {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}

function zipEntryBytes(entry) {
    return typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : new Uint8Array(entry.data);
}

/** Build an uncompressed (STORE-only) ZIP from bytes or UTF-8 strings. */
export function createStoredZip(entries, modifiedAt = new Date()) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('A ZIP needs at least one entry.');
    }
    const encoder = new TextEncoder();
    const { date, time } = dosDateTime(modifiedAt);
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;

    for (const entry of entries) {
        if (!entry?.name) throw new Error('Every ZIP entry needs a name.');
        const name = encoder.encode(entry.name);
        const data = zipEntryBytes(entry);
        const checksum = crc32(data);
        const local = new Uint8Array(30 + name.length);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, LOCAL_FILE_HEADER, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, 0x0800, true);
        localView.setUint16(8, 0, true);
        localView.setUint16(10, time, true);
        localView.setUint16(12, date, true);
        localView.setUint32(14, checksum, true);
        localView.setUint32(18, data.length, true);
        localView.setUint32(22, data.length, true);
        localView.setUint16(26, name.length, true);
        local.set(name, 30);
        localParts.push(local, data);

        const central = new Uint8Array(46 + name.length);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, CENTRAL_FILE_HEADER, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, 0x0800, true);
        centralView.setUint16(10, 0, true);
        centralView.setUint16(12, time, true);
        centralView.setUint16(14, date, true);
        centralView.setUint32(16, checksum, true);
        centralView.setUint32(20, data.length, true);
        centralView.setUint32(24, data.length, true);
        centralView.setUint16(28, name.length, true);
        centralView.setUint32(42, localOffset, true);
        central.set(name, 46);
        centralParts.push(central);

        localOffset += local.length + data.length;
    }

    const centralDirectory = concatBytes(centralParts);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralDirectory.length, true);
    endView.setUint32(16, localOffset, true);
    return concatBytes([...localParts, centralDirectory, end]);
}

export function safeExportFilename(value, fallback = 'book') {
    const title = String(value || fallback)
        .replace(/\.(pdf|epub|txt|md)$/i, '')
        .replace(/[<>:"/\\|?*]/g, '-');
    const printable = [...title]
        .filter((character) => character.charCodeAt(0) >= 32)
        .join('')
        .replace(/[. ]+$/g, '')
        .trim();
    return printable || fallback;
}

export function pageAudioFilename(bookTitle, startPage, endPage) {
    const title = safeExportFilename(bookTitle);
    return startPage === endPage
        ? `${title}-page-${startPage}.wav`
        : `${title}-pages-${startPage}-${endPage}.zip`;
}

export function createPageAudioManifest(bookTitle, startPage, endPage, exportedAt) {
    return {
        bookTitle: String(bookTitle || 'Book'),
        pageCount: endPage - startPage + 1,
        startPage,
        endPage,
        exportedAt: exportedAt.toISOString(),
    };
}

function pagesInRange(pages, startPage, endPage) {
    const byPage = new Map((pages || []).map((page) => [Number(page.page), page]));
    const selected = [];
    for (let page = startPage; page <= endPage; page += 1) {
        const metadata = byPage.get(page);
        if (!metadata?.audioUrl) throw new Error(`Page ${page} has no prepared audio.`);
        selected.push({ ...metadata, page });
    }
    return selected;
}

/** Pass through a canonical single-page WAV URL without fetching or repackaging it. */
export function createSinglePageDownload({ bookTitle, page, audioUrl }) {
    if (!audioUrl) throw new Error(`Page ${page} has no prepared audio.`);
    return {
        downloadUrl: audioUrl,
        filename: pageAudioFilename(bookTitle, page, page),
    };
}

/** Fetch selected prepared page WAVs and return a STORE-only ZIP Blob. */
export async function buildPageAudioZip({
    bookTitle,
    pages,
    startPage,
    endPage,
    onProgress,
    fetchImpl = fetch,
    exportedAt = new Date(),
}) {
    const selected = pagesInRange(pages, startPage, endPage);
    const entries = [];
    for (let index = 0; index < selected.length; index += 1) {
        const page = selected[index];
        onProgress?.({ current: index + 1, total: selected.length, page: page.page });
        const response = await fetchImpl(page.audioUrl);
        if (!response.ok) throw new Error(`Could not download page ${page.page} audio.`);
        const blob = await response.blob();
        entries.push({ name: `page-${page.page}.wav`, data: await blob.arrayBuffer() });
    }
    entries.push({
        name: 'manifest.json',
        data: JSON.stringify(createPageAudioManifest(bookTitle, startPage, endPage, exportedAt), null, 2),
    });
    return createStoredZip(entries, exportedAt);
}
