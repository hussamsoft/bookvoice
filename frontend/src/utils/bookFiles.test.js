import { describe, expect, it } from 'vitest';
import { libraryBookFile, sourceKindFromName } from './bookFiles';

describe('sourceKindFromName', () => {
    it('maps file extensions to book kinds', () => {
        expect(sourceKindFromName('novel.epub')).toBe('epub');
        expect(sourceKindFromName('notes.txt')).toBe('txt');
        expect(sourceKindFromName('README.MD')).toBe('txt');
        expect(sourceKindFromName('book.pdf')).toBe('pdf');
        expect(sourceKindFromName('unknown')).toBe('pdf');
        expect(sourceKindFromName()).toBe('pdf');
    });
});

describe('libraryBookFile', () => {
    const book = { title: 'My Book', sourceKind: 'txt', updatedAt: 1700000000 };

    it('builds an empty synthetic file for text books', () => {
        const file = libraryBookFile(book);
        expect(file.name).toBe('My Book.txt');
        expect(file.type).toBe('text/plain');
        expect(file.size).toBe(0);
        expect(file.lastModified).toBe(1700000000 * 1000);
    });

    it('wraps the fetched source blob for PDFs', () => {
        const source = new Blob(['%PDF-1.4']);
        const file = libraryBookFile({ ...book, sourceKind: 'pdf' }, source);
        expect(file.name).toBe('My Book.pdf');
        expect(file.type).toBe('application/pdf');
        expect(file.size).toBe(source.size);
        expect(file.lastModified).toBe(1700000000 * 1000);
    });

    it('keeps the fingerprint stable across re-opens of the same book', () => {
        const first = libraryBookFile(book);
        const second = libraryBookFile(book);
        // documentFingerprint is name \0 size \0 lastModified; equal here.
        expect(`${first.name}\0${first.size}\0${first.lastModified}`)
            .toBe(`${second.name}\0${second.size}\0${second.lastModified}`);
    });

    it('falls back to a pdf file with a generic title', () => {
        const file = libraryBookFile(null);
        expect(file.name).toContain('Prepared book.pdf');
        expect(file.type).toBe('application/pdf');
    });
});
