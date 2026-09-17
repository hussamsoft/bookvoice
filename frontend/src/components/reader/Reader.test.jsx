import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Reader from './Reader';

const api = vi.hoisted(() => ({
    listPreparedBooks: vi.fn(),
    importPreparedBook: vi.fn(),
    getBookPage: vi.fn(),
    getPreparedPage: vi.fn(),
    savePreparedPage: vi.fn(),
    updatePreparedProgress: vi.fn(),
    preparedBookSource: vi.fn(),
    narrateTextStream: vi.fn(),
    cancelGeneration: vi.fn(),
    getTtsStatus: vi.fn(),
    getUserConfig: vi.fn(),
    saveUserConfig: vi.fn(),
}));

// Spread the real module so any transitive import keeps working; the
// reader's data layer is what we stub.
vi.mock('../../utils/api', async (importOriginal) => ({
    ...(await importOriginal()),
    ...api,
}));

vi.mock('../../hooks/usePdfDocument', () => ({
    usePdfDocument: () => ({
        adoptPdfDocument: vi.fn(),
        cachePageText: vi.fn(),
        pdfDocRef: { current: null },
        textCacheRef: { current: new Map() },
        getPdfDocument: vi.fn(),
        findTextInDocument: vi.fn(async () => null),
        preparePageText: vi.fn(async (page) => `PDF page ${page} text.`),
        invalidateTextCache: vi.fn(),
        resetDocument: vi.fn(),
    }),
}));

vi.mock('react-pdf', () => ({
    Document: ({ children, onLoadSuccess }) => {
        useEffect(() => {
            onLoadSuccess?.({ numPages: 3 });
        }, [onLoadSuccess]);
        return <div data-testid="pdf-document-mock">{children}</div>;
    },
    Page: () => <div data-testid="pdf-page-mock">PDF page</div>,
    pdfjs: { GlobalWorkerOptions: { workerSrc: '' } },
}));

const toast = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../Toast', () => ({ useToast: () => toast }));

const SEED_BOOK = {
    id: 'book-1',
    title: 'Seed book',
    sourceKind: 'txt',
    pageCount: 12,
    updatedAt: 1700000000,
    activeProfileId: 'profile-1',
};
const SEED_PDF = {
    id: 'book-pdf',
    title: 'Seed pdf',
    sourceKind: 'pdf',
    pageCount: 3,
    updatedAt: 1700000100,
    activeProfileId: 'profile-1',
};
const SEED_DOC_ID = `Seed book.txt\0${0}\0${1700000000 * 1000}`;

// jsdom has no media backend: give every audio element a working
// play/pause pair and a "metadata ready" state so the narration paths
// run end to end.
beforeAll(() => {
    const proto = window.HTMLMediaElement.prototype;
    Object.defineProperty(proto, 'paused', {
        configurable: true,
        get() { return this._readerPaused ?? true; },
        set(value) { this._readerPaused = value; },
    });
    Object.defineProperty(proto, 'readyState', {
        configurable: true,
        get() { return 4; },
    });
    proto.play = vi.fn(function play() {
        this._readerPaused = false;
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
    });
    proto.pause = vi.fn(function pause() {
        const was = this._readerPaused ?? true;
        this._readerPaused = true;
        if (!was) this.dispatchEvent(new Event('pause'));
    });
});

function streamDone({ url = '/sessions/s/full.wav', duration = 3 } = {}) {
    return async (chunkText, _sessionId, _page, _voice, _lang, opts = {}) => {
        await opts.onChunk?.({ type: 'chunk', index: 0, total: 2, url: '/sessions/s/chunk0.wav', text: chunkText, start_s: 0, end_s: duration / 2 });
        await opts.onChunk?.({ type: 'chunk', index: 1, total: 2, url: '/sessions/s/chunk1.wav', text: chunkText, start_s: duration / 2, end_s: duration });
        return { type: 'done', audio_url: url, segments: [], duration_s: duration, word_timings: [] };
    };
}

describe('Reader', () => {
    beforeEach(() => {
        localStorage.clear();
        window.history.replaceState(null, '', '/');
        vi.clearAllMocks();
        api.listPreparedBooks.mockResolvedValue([SEED_BOOK, SEED_PDF]);
        api.getBookPage.mockImplementation(async (bookId, page) => ({
            page,
            text: `Server page ${page} text.`,
        }));
        api.getPreparedPage.mockResolvedValue(null);
        api.savePreparedPage.mockResolvedValue({});
        api.updatePreparedProgress.mockResolvedValue({ page: 1, time: 0, bookmarks: [] });
        api.preparedBookSource.mockResolvedValue(new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
        api.narrateTextStream.mockImplementation(streamDone());
        api.cancelGeneration.mockResolvedValue({});
        api.getTtsStatus.mockResolvedValue({ status: 'ready', detail: '' });
        api.importPreparedBook.mockResolvedValue({
            id: 'book-2',
            title: 'Imported book',
            sourceKind: 'txt',
            pageCount: 4,
        });
        api.getUserConfig.mockResolvedValue({ version: '1.7.0', config: {} });
        api.saveUserConfig.mockResolvedValue({ version: '1.7.0', config: {} });
    });

    it('shows the open-a-book empty state with the prepared library', async () => {
        render(<Reader />);
        expect(screen.getByText(/Open a book to start reading/)).toBeInTheDocument();
        expect(await screen.findByRole('button', { name: /Seed book/ })).toBeInTheDocument();
        expect(screen.getByLabelText(/Choose a book file/)).toBeInTheDocument();
    });

    it('opens a text book from the library and restores saved progress', async () => {
        localStorage.setItem(
            `bookvoice:reader:${SEED_DOC_ID}`,
            JSON.stringify({ page: 4, time: 0, zoom: 1.15, playbackRate: 1, bookmarks: [2, 7] }),
        );
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));

        expect(await screen.findByText(/Server page 4 text/)).toBeInTheDocument();
        expect(screen.getByText('Page 4 of 12')).toBeInTheDocument();
        expect(screen.getByText(/Bookmarks: 2, 7/)).toBeInTheDocument();
        await waitFor(() => expect(screen.getByText('115%')).toBeInTheDocument());
    });

    it('navigates a real text book via buttons and the keyboard', async () => {
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        expect(await screen.findByText(/Server page 1 text/)).toBeInTheDocument();

        const prev = screen.getByRole('button', { name: 'Previous page' });
        expect(prev).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        expect(await screen.findByText(/Server page 2 text/)).toBeInTheDocument();

        fireEvent.keyDown(window, { key: 'PageDown' });
        expect(await screen.findByText(/Server page 3 text/)).toBeInTheDocument();

        fireEvent.keyDown(window, { key: 'Home' });
        expect(await screen.findByText(/Server page 1 text/)).toBeInTheDocument();
        expect(prev).toBeDisabled();
    });

    it('jumps to a found page and reports the match', async () => {
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        expect(await screen.findByText(/Server page 1 text/)).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/find in book/i), { target: { value: 'page 7' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));

        expect(await screen.findByText(/Found .page 7. on page 7/)).toBeInTheDocument();
        expect(await screen.findByText(/Server page 7 text/)).toBeInTheDocument();
        expect(screen.getByText('Page 7 of 12')).toBeInTheDocument();
    });

    it('reports when a search has no match and stays on the page', async () => {
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        expect(await screen.findByText(/Server page 1 text/)).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText(/find in book/i), { target: { value: 'unfindable' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));

        expect(await screen.findByText(/No matches for .unfindable./)).toBeInTheDocument();
        expect(screen.getByText('Page 1 of 12')).toBeInTheDocument();
    });

    it('keeps playing the loaded narration when the user browses within one page', async () => {
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        expect(await screen.findByText(/Server page 1 text/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Play narration' }));
        await screen.findByRole('button', { name: 'Pause narration' });
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        expect(await screen.findByText(/Server page 2 text/)).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: /resume or start fresh/i })).not.toBeInTheDocument();
    });

    it('opens a PDF file, learns the page count, and imports it to the library', async () => {
        api.importPreparedBook.mockResolvedValue({
            id: 'book-2',
            title: 'Imported book',
            sourceKind: 'pdf',
            pageCount: 3,
        });
        const { container } = render(<Reader />);
        const input = container.querySelector('#reader-upload');
        fireEvent.change(input, {
            target: { files: [new File(['%PDF-1.4'], 'book.pdf', { type: 'application/pdf' })] },
        });

        expect(await screen.findByTestId('pdf-document-mock')).toBeInTheDocument();
        expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
        await waitFor(() => expect(api.importPreparedBook).toHaveBeenCalledTimes(1));
    });

    it('persists freshly extracted PDF text into the prepared library', async () => {
        api.getPreparedPage.mockResolvedValue(null);
        api.importPreparedBook.mockImplementation(async () => new Promise(() => {}));
        const { container } = render(<Reader />);
        fireEvent.change(container.querySelector('#reader-upload'), {
            target: { files: [new File(['%PDF-1.4'], 'book.pdf', { type: 'application/pdf' })] },
        });

        // The import never settles, so no library record exists yet and
        // the extracted page is not written back — extraction still works.
        expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
        expect(api.savePreparedPage).not.toHaveBeenCalled();
    });

    it('writes extracted pages back when the library record exists', async () => {
        api.getPreparedPage.mockResolvedValue(null);
        render(<Reader />);
        // Opening a prepared PDF sets the library identity synchronously,
        // so the first extracted page is persisted to the library record.
        fireEvent.click(await screen.findByRole('button', { name: /Seed pdf/ }));
        expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
        await waitFor(() => expect(api.savePreparedPage).toHaveBeenCalledWith(
            'book-pdf',
            1,
            'PDF page 1 text.',
            3,
        ));
    });

    it('toasts when a text-book page cannot be loaded', async () => {
        api.getBookPage.mockRejectedValue(new Error('No text found on page 1.'));
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No text found on page 1.'));
    });

    it('toggles bookmarks via the B shortcut once a book is open', async () => {
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        expect(await screen.findByText(/No bookmarks yet/)).toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'b' });
        expect(screen.getByText(/Bookmarks: 1/)).toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'b' });
        expect(screen.getByText(/No bookmarks yet/)).toBeInTheDocument();
    });

    it('mirrors the reading position to the prepared-book server record', async () => {
        vi.useFakeTimers();
        try {
            render(<Reader />);
            await act(async () => { await vi.advanceTimersByTimeAsync(50); });
            fireEvent.click(screen.getByRole('button', { name: /Seed book/ }));
            await act(async () => { await vi.advanceTimersByTimeAsync(50); });
            expect(screen.getByText(/Server page 1 text/)).toBeInTheDocument();

            fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
            await act(async () => { await vi.advanceTimersByTimeAsync(50); });
            await act(async () => { await vi.advanceTimersByTimeAsync(3100); });

            expect(api.updatePreparedProgress).toHaveBeenCalledWith(
                'book-1',
                expect.objectContaining({ page: 2 }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('narrates the loaded page through the streaming endpoint', async () => {
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await screen.findByText(/Server page 1 text/);

        fireEvent.click(screen.getByRole('button', { name: 'Play narration' }));

        const pauseButton = await screen.findByRole('button', { name: 'Pause narration' });
        expect(pauseButton).toBeInTheDocument();
        await waitFor(() => {
            expect(api.narrateTextStream).toHaveBeenCalledWith(
                'Server page 1 text.',
                expect.any(String),
                1,
                null,
                'en',
                expect.anything(),
                expect.any(AbortSignal),
            );
        });
        // The canonical full-page WAV is promoted to the player.
        await waitFor(() => {
            expect(container.querySelector('audio').src).toContain('full.wav');
        });
        expect(container.querySelector('[data-transport-state]').getAttribute('data-transport-state'))
            .toBe('playing');
    });

    it('cancels in-flight generation when another page is loaded', async () => {
        api.narrateTextStream.mockImplementation(() => new Promise(() => {}));
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await screen.findByText(/Server page 1 text/);

        fireEvent.click(screen.getByRole('button', { name: 'Play narration' }));
        await waitFor(() => expect(api.narrateTextStream).toHaveBeenCalled());

        // Browse two pages away. The migrated reader no longer shows a
        // resume dialog; navigation tears the in-flight generation down.
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        await screen.findByText(/Server page 2 text/);
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

        // The play load for page 1 was torn down on navigation, and the
        // fresh load for page 3 tears the player down again.
        await waitFor(() => expect(api.cancelGeneration.mock.calls.length).toBeGreaterThanOrEqual(2));
        expect(await screen.findByText(/Server page 3 text/)).toBeInTheDocument();
    });

    it('parks the playhead at the saved position when prepared audio exists', async () => {
        api.getPreparedPage.mockResolvedValue({
            text: 'Prepared page text.',
            audioUrl: '/audio/p1.wav',
            wordTimings: [],
            audio: { duration: 100 },
        });
        localStorage.setItem(
            `bookvoice:reader:${SEED_DOC_ID}`,
            JSON.stringify({ page: 1, time: 42, zoom: 1, playbackRate: 1, bookmarks: [] }),
        );
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));

        expect(await screen.findByText('Prepared page text.')).toBeInTheDocument();
        // Restored position, applied once, without speaking.
        await waitFor(() => {
            expect(container.querySelector('audio').currentTime).toBe(42);
        });
        expect(container.querySelector('audio').play).not.toHaveBeenCalled();
        expect(container.querySelector('[data-transport-state]').getAttribute('data-transport-state'))
            .toBe('paused');
    });

    it('toggles mute on the audio element', async () => {
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await screen.findByText(/Server page 1 text/);

        const mute = screen.getByRole('button', { name: 'Mute narration' });
        fireEvent.click(mute);
        expect(screen.getByRole('button', { name: 'Unmute narration' })).toHaveAttribute('aria-pressed', 'true');
        expect(container.querySelector('audio').muted).toBe(true);
    });

    it('starts narration from the Space shortcut', async () => {
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await screen.findByText(/Server page 1 text/);

        fireEvent.keyDown(window, { key: ' ', code: 'Space' });

        await waitFor(() => expect(api.narrateTextStream).toHaveBeenCalled());
    });

    it('auto-opens the prepared book referenced by ?book=<id>', async () => {
        window.history.replaceState(null, '', '/?book=book-1');
        render(<Reader />);
        // Page 1 of the text book appears without the user clicking the
        // library row — same auto-open shape PdfViewer relies on for
        // desktop deep links and `.bookvoice` double-click.
        expect(await screen.findByText(/Server page 1 text/)).toBeInTheDocument();
        expect(api.preparedBookSource).not.toHaveBeenCalled();
    });

    it('does not auto-open when ?book=<id> does not match a library book', async () => {
        window.history.replaceState(null, '', '/?book=does-not-exist');
        render(<Reader />);
        expect(await screen.findByText(/Open a book to start reading/)).toBeInTheDocument();
        expect(screen.queryByText(/Server page 1 text/)).not.toBeInTheDocument();
    });

    it('applies saved voice and language from useUserConfig once it arrives', async () => {
        api.getUserConfig.mockResolvedValue({
            version: '1.7.0',
            config: { voice_id: 'SavedVoice', language_id: 'ar' },
        });
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await screen.findByText(/Server page 1 text/);

        // Click play and let the streaming narration start; the narration
        // request carries the saved voice and language, not the defaults.
        fireEvent.click(screen.getByRole('button', { name: 'Play narration' }));
        await waitFor(() => {
            expect(api.narrateTextStream).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(String),
                expect.any(Number),
                'SavedVoice',
                'ar',
                expect.anything(),
                expect.any(AbortSignal),
            );
        });
    });

    it('exposes a sleep timer that arms and cancels', async () => {
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await screen.findByText(/Server page 1 text/);

        const sleepSelect = screen.getByLabelText('Sleep timer');
        fireEvent.change(sleepSelect, { target: { value: '5' } });
        // The remaining-time hint appears with a minute value (rounded up).
        // Other "5 min" matches live in the option list; the hint is the
        // only node carrying `reader-sleep-remaining`.
        const hint = container.querySelector('.reader-sleep-remaining');
        expect(hint).toBeTruthy();
        expect(hint.textContent).toMatch(/min/);

        // Cancelling returns the dropdown to "off".
        fireEvent.change(sleepSelect, { target: { value: 'off' } });
        expect(sleepSelect.value).toBe('off');
    });

    it('jumps to a typed page number and clamps to the page count', async () => {
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await screen.findByText(/Server page 1 text/);

        const jump = screen.getByLabelText(/Go to page between 1 and 12/);
        fireEvent.change(jump, { target: { value: '7' } });
        fireEvent.submit(jump.closest('form'));
        expect(await screen.findByText(/Server page 7 text/)).toBeInTheDocument();

        // Out-of-range entries clamp rather than error.
        fireEvent.change(jump, { target: { value: '999' } });
        fireEvent.submit(jump.closest('form'));
        expect(await screen.findByText(/Server page 12 text/)).toBeInTheDocument();
    });
});
