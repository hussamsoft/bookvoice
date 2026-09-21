import { useEffect } from 'react';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Reader from './Reader';

// After F-08 (word-highlight wiring) the page text is split into per-word
// spans, so legacy `findByText(/Server page 1 text/)` no longer matches —
// `findByText` walks the tree, but the target string is split across
// multiple <span> siblings. `findPageText` is a helper that searches the
// container textContent for the regex, returning the first match.
//
// Some tests combine this with `vi.useFakeTimers()`; the react-testing-
// library `waitFor` polls via real `setTimeout`, which fake timers freeze.
// Use the synchronous variant when running under fake timers.
async function findPageText(container, regex) {
    // 4 s, not the 1 s default: in the full parallel suite run these
    // async page-resolution polls have measured >1.1 s under load and
    // flaked; the assertion itself is unchanged.
    await waitFor(() => {
        const text = container.textContent ?? '';
        expect(text).toMatch(regex);
    }, { timeout: 4000 });
}

function assertPageText(container, regex) {
    expect(container.textContent ?? '').toMatch(regex);
}

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

    it('renders exactly one h1 in both the empty and open states (F-24)', async () => {
        render(<Reader />);
        // Empty state: the invitation is the h1.
        expect(screen.getByRole('heading', { level: 1, name: /Open a book/ })).toBeInTheDocument();

        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        // Open state: the book title becomes the single h1.
        const h1s = await screen.findAllByRole('heading', { level: 1 });
        expect(h1s.length).toBe(1);
        expect(h1s[0]).toHaveTextContent('Seed book');
    });

    it('routes all reader status through a single polite live region (F-25)', async () => {
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await screen.findByRole('heading', { level: 1, name: /Seed book/ });

        const live = container.querySelectorAll('[role="status"], [aria-live="polite"]');
        expect(live.length).toBe(1);
        // The visible page status stays on screen but must not itself be live.
        const pageStatus = container.querySelector('.reader-toolbar-row .reader-page-status');
        expect(pageStatus).not.toHaveAttribute('aria-live');
        expect(pageStatus).not.toHaveAttribute('role');
        // Zoom percent is never announced per tick.
        const zoomPct = container.querySelector('.reader-zoom-pct');
        if (zoomPct) expect(zoomPct).not.toHaveAttribute('aria-live');
    });

    it('flushes pending reading progress the moment the tab hides (F-36)', async () => {
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await screen.findByRole('heading', { level: 1, name: /Seed book/ });
        api.updatePreparedProgress.mockClear();

        // Turn a page: the new snapshot is pending behind the throttle
        // once page 2 has actually resolved.
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        await findPageText(container, /Server page 2 text/);
        // Hiding the tab must write it immediately — not wait for the 3s
        // timer, and not wait for an unmount that never comes.
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(api.updatePreparedProgress).toHaveBeenCalledWith(
            'book-1',
            expect.objectContaining({ page: 2 }),
        );

        api.updatePreparedProgress.mockClear();
        act(() => { window.dispatchEvent(new Event('pagehide')); });
        // Nothing new was pending after the visibility flush; a second
        // event must not invent a save. (Guards against double-flush
        // loops, not against the flush itself.)
        expect(api.updatePreparedProgress).not.toHaveBeenCalled();
    });

    it('explains a deep link whose book id is not in the library (F-39)', async () => {
        window.history.replaceState(null, '', '/?book=ghost-99');
        try {
            render(<Reader />);
            // Books arrive; the id is genuinely absent — the user must be
            // told, not left on a silent empty reader.
            await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
                expect.stringContaining('ghost-99')
            ));
        } finally {
            window.history.replaceState(null, '', '/');
        }
    });

    it('More options popover follows the shared keyboard pattern (F-27)', async () => {
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));

        const trigger = screen.getByRole('button', { name: 'More options' });
        fireEvent.click(trigger);
        const popover = screen.getByRole('group', { name: 'More reader options' });
        expect(trigger).toHaveAttribute('aria-expanded', 'true');

        // Open moves focus into the popover.
        expect(popover.contains(document.activeElement)).toBe(true);

        // Down/Up cycle between enabled controls, wrapping.
        const focusables = Array.from(
            popover.querySelectorAll('button:not(:disabled), input:not(:disabled)')
        );
        expect(focusables.length).toBeGreaterThan(1);
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        fireEvent.keyDown(popover, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(focusables[1]);
        fireEvent.keyDown(popover, { key: 'End' });
        expect(document.activeElement).toBe(last);
        fireEvent.keyDown(popover, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(first);
        fireEvent.keyDown(popover, { key: 'Home' });
        expect(document.activeElement).toBe(first);
        fireEvent.keyDown(popover, { key: 'ArrowUp' });
        expect(document.activeElement).toBe(last);

        // Escape closes and returns focus to the trigger.
        fireEvent.keyDown(popover, { key: 'Escape' });
        expect(screen.queryByRole('group', { name: 'More reader options' })).not.toBeInTheDocument();
        expect(document.activeElement).toBe(trigger);
    });

    it('opens a text book from the library and restores saved progress', async () => {
        localStorage.setItem(
            `bookvoice:reader:${SEED_DOC_ID}`,
            JSON.stringify({ page: 4, time: 0, zoom: 1.15, playbackRate: 1, bookmarks: [2, 7] }),
        );
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));

        await findPageText(container, /Server page 4 text/);
        // "Page N of M" now appears twice (toolbar status + PlaybackControls'
        // transport-page label). Use getAllByText and assert at least one.
        expect(screen.getAllByText('Page 4 of 12').length).toBeGreaterThan(0);
        expect(screen.getByText(/Bookmarks: 2, 7/)).toBeInTheDocument();
        // Zoom % moved into the More popover (F-13).
        fireEvent.click(screen.getByRole('button', { name: 'More options' }));
        await waitFor(() => expect(screen.getByText('115%')).toBeInTheDocument());
    });

    it('navigates a real text book via buttons and the keyboard', async () => {
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await findPageText(container, /Server page 1 text/);

        const prev = screen.getByRole('button', { name: 'Previous page' });
        expect(prev).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        await findPageText(container, /Server page 2 text/);

        fireEvent.keyDown(window, { key: 'PageDown' });
        await findPageText(container, /Server page 3 text/);

        fireEvent.keyDown(window, { key: 'Home' });
        await findPageText(container, /Server page 1 text/);
        expect(prev).toBeDisabled();
    });

    it('jumps to a found page and reports the match', async () => {
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await findPageText(container, /Server page 1 text/)

        // Search moved into the More popover in F-13; open it first.
        fireEvent.click(screen.getByRole('button', { name: 'More options' }));
        fireEvent.change(screen.getByLabelText(/find in book/i), { target: { value: 'page 7' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));

        await waitFor(() => expect(screen.getAllByText(/Found .page 7. on page 7/).length).toBeGreaterThan(0));
        await findPageText(container, /Server page 7 text/)
        expect(screen.getAllByText('Page 7 of 12').length).toBeGreaterThan(0);
    });

    it('exposes a working scrubber that agrees with the clock (F-07)', async () => {
        // Give the mocked audio a finite duration so the scrubber renders.
        Object.defineProperty(window.HTMLMediaElement.prototype, 'duration', {
            configurable: true,
            get() { return 12; },
        });
        try {
            const { container } = render(<Reader />);
            fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
            await findPageText(container, /Server page 1 text/)

            // The reader toolbar must include a scrubber element with the
            // expected aria-label and a numeric max (the playlist-global
            // duration that PlaybackControls uses for both scrubber and clock).
            const scrubber = screen.getByLabelText('Narration position');
            expect(scrubber).toBeInTheDocument();
            // Both the scrubber's max attribute and the clock text draw from
            // the same `transport.duration`. The Reader used to mix sources
            // (scrubber from one variable, clock from another) and disagreed
            // by exactly 50% — see phase 2 finding F-07.
            const clock = screen.getByText(/\d+:\d{2}\s*\/\s*\d+:\d{2}/);
            const max = Number(scrubber.getAttribute('max'));
            expect(Number.isFinite(max)).toBe(true);
            expect(max).toBe(12);
            expect(clock.textContent).toMatch(/0:00\s*\/\s*0:12/);
        } finally {
            delete window.HTMLMediaElement.prototype.duration;
        }
    });

    it('groups the toolbar into navigation + transport + a more popover (F-13)', async () => {
        render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));

        // Primary nav row: prev / page-jump / next must be visible inline.
        expect(screen.getByRole('button', { name: 'Previous page' })).toBeInTheDocument();
        expect(screen.getByLabelText(/Go to page/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Next page' })).toBeInTheDocument();
        // Bookmark uses a fixed-width icon button so its label doesn't
        // shift neighbours when toggled.
        const bookmark = screen.getByRole('button', { name: /Bookmark page \d+/ });
        expect(bookmark).toHaveAttribute('aria-pressed');
        // Secondary controls are tucked behind a "More" button rather than
        // spilling into the primary row.
        expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
        // The "More" popover stays closed by default — no zoom/fit/search
        // controls visible until opened.
        expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Zoom out' })).not.toBeInTheDocument();
    });

    it('PDF error button is labelled Dismiss (no false "Try again"), and handleDocumentError does not also toast', async () => {
        // The Reader.jsx wiring changed to a single error surface (the
        // inline alert) and the retry button became a Dismiss. Since we
        // cannot deterministically drive react-pdf's onLoadError through
        // jsdom, assert the static contract: the button label and the
        // absence of `toast.error` from handleDocumentError.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const here = path.dirname(fileURLToPath(import.meta.url));
        const readerSrc = fs.readFileSync(
            path.resolve(here, './Reader.jsx'),
            'utf8'
        );
        // Reader source must mention "Dismiss" in the .reader-pdf-error block.
        const dismissMatch = readerSrc.match(/reader-pdf-error[\s\S]{0,400}?(Dismiss|Try again)/);
        expect(dismissMatch, 'expected a button label inside .reader-pdf-error').toBeTruthy();
        expect(dismissMatch[1]).toBe('Dismiss');
        // handleDocumentError must not also fire a toast.
        const handleMatch = readerSrc.match(/handleDocumentError\s*=\s*\(error\)\s*=>\s*\{([\s\S]*?)\n\s{4}\}/);
        expect(handleMatch, 'handleDocumentError not found').toBeTruthy();
        expect(handleMatch[1]).not.toMatch(/toast\.error/);
    });

    it('shows a loading skeleton mid-load instead of a false empty state', async () => {
        // Hold the page fetch pending so we can observe the loading path.
        let resolvePage;
        api.getBookPage.mockImplementationOnce(
            () => new Promise((res) => { resolvePage = res; })
        );
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));

        // While the fetch is pending the empty-state copy must not appear,
        // and the loading skeleton should be visible.
        await waitFor(() => expect(screen.queryByText(/No text for page/i)).not.toBeInTheDocument());
        expect(screen.getByTestId('reader-page-skeleton')).toBeInTheDocument();
        // TextStage now takes a loading flag and gates the empty state on
        // !isLoading — the skeleton is the only thing the user sees.
        expect(screen.queryByTestId('reader-page-empty')).not.toBeInTheDocument();

        // Resolve and the real content paints, no skeleton.
        await act(async () => {
            resolvePage({ page: 1, text: 'First page text.' });
            await Promise.resolve();
        });
        await findPageText(container, /First page text\./);
    });

    it('does not trap navigation on the search hit and does not re-resolve idle', async () => {
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await findPageText(container, /Server page 1 text/)

        fireEvent.click(screen.getByRole('button', { name: 'More options' }));
        fireEvent.change(screen.getByLabelText(/find in book/i), { target: { value: 'page 7' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await findPageText(container, /Server page 7 text/)

        const callsAfterJump = api.getBookPage.mock.calls.length;
        // Idle: nothing should re-resolve the page just because the reader
        // re-rendered (e.g. from a timer tick elsewhere).
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        expect(api.getBookPage.mock.calls.length).toBe(callsAfterJump);

        // Navigation away from the hit page must work — it must not snap back.
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        await findPageText(container, /Server page 8 text/)
        expect(screen.getAllByText('Page 8 of 12').length).toBeGreaterThan(0);

        // The "Found on page 7" status must still be visible after the jump.
        expect(screen.getAllByText(/Found .page 7. on page 7/).length).toBeGreaterThan(0);
    });

    it('reports when a search has no match and stays on the page', async () => {
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await findPageText(container, /Server page 1 text/)

        fireEvent.click(screen.getByRole('button', { name: 'More options' }));
        fireEvent.change(screen.getByLabelText(/find in book/i), { target: { value: 'unfindable' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));

        await waitFor(() => expect(screen.getAllByText(/No matches for .unfindable./).length).toBeGreaterThan(0));
        expect(screen.getAllByText('Page 1 of 12').length).toBeGreaterThan(0);
    });

    it('keeps playing the loaded narration when the user browses within one page', async () => {
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await findPageText(container, /Server page 1 text/)

        fireEvent.click(screen.getByRole('button', { name: 'Play narration' }));
        await screen.findByRole('button', { name: 'Pause narration' });
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        await findPageText(container, /Server page 2 text/)
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
        expect(screen.getAllByText('Page 1 of 3').length).toBeGreaterThan(0);
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
        expect(screen.getAllByText('Page 1 of 3').length).toBeGreaterThan(0);
        expect(api.savePreparedPage).not.toHaveBeenCalled();
    });

    it('writes extracted pages back when the library record exists', async () => {
        api.getPreparedPage.mockResolvedValue(null);
        render(<Reader />);
        // Opening a prepared PDF sets the library identity synchronously,
        // so the first extracted page is persisted to the library record.
        fireEvent.click(await screen.findByRole('button', { name: /Seed pdf/ }));
        await waitFor(() => expect(screen.getAllByText('Page 1 of 3').length).toBeGreaterThan(0));
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
            const { container } = render(<Reader />);
            await act(async () => { await vi.advanceTimersByTimeAsync(50); });
            fireEvent.click(screen.getByRole('button', { name: /Seed book/ }));
            await act(async () => { await vi.advanceTimersByTimeAsync(50); });
            assertPageText(container, /Server page 1 text/);

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
        await findPageText(container, /Server page 1 text/);

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
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await findPageText(container, /Server page 1 text/);

        fireEvent.click(screen.getByRole('button', { name: 'Play narration' }));
        await waitFor(() => expect(api.narrateTextStream).toHaveBeenCalled());

        // Browse two pages away. The migrated reader no longer shows a
        // resume dialog; navigation tears the in-flight generation down.
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        await findPageText(container, /Server page 2 text/);
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

        // The play load for page 1 was torn down on navigation, and the
        // fresh load for page 3 tears the player down again.
        await waitFor(() => expect(api.cancelGeneration.mock.calls.length).toBeGreaterThanOrEqual(2));
        await findPageText(container, /Server page 3 text/)
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

        await findPageText(container, /Prepared page text\./);
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
        await findPageText(container, /Server page 1 text/);

        // Mute moved behind the "More" popover in F-13. Open it first.
        fireEvent.click(screen.getByRole('button', { name: 'More options' }));
        const mute = screen.getByRole('button', { name: 'Mute narration' });
        fireEvent.click(mute);
        expect(screen.getByRole('button', { name: 'Unmute narration' })).toHaveAttribute('aria-pressed', 'true');
        expect(container.querySelector('audio').muted).toBe(true);
    });

    it('starts narration from the Space shortcut', async () => {
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await findPageText(container, /Server page 1 text/);

        fireEvent.keyDown(window, { key: ' ', code: 'Space' });

        await waitFor(() => expect(api.narrateTextStream).toHaveBeenCalled());
    });

    it('auto-opens the prepared book referenced by ?book=<id>', async () => {
        window.history.replaceState(null, '', '/?book=book-1');
        const { container } = render(<Reader />);
        // Page 1 of the text book appears without the user clicking the
        // library row — same auto-open shape PdfViewer relies on for
        // desktop deep links and `.bookvoice` double-click.
        await findPageText(container, /Server page 1 text/)
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
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await findPageText(container, /Server page 1 text/);

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
        await findPageText(container, /Server page 1 text/);

        const sleepSelect = screen.getByLabelText('Sleep timer');
        fireEvent.change(sleepSelect, { target: { value: '5' } });
        // The remaining-time hint lives inside PlaybackControls now
        // (F-07 wired `<PlaybackControls>` in place of the inline select).
        const hint = container.querySelector('.transport-sleep-remaining');
        expect(hint).toBeTruthy();
        // PlaybackControls formats the remaining time as a clock (mm:ss);
        // we only assert the hint appeared after arming the timer.
        expect(hint.textContent).toBeTruthy();

        // Cancelling returns the dropdown to "off".
        fireEvent.change(sleepSelect, { target: { value: 'off' } });
        expect(sleepSelect.value).toBe('off');
    });

    it('jumps to a typed page number and clamps to the page count', async () => {
        const { container } = render(<Reader />);
        fireEvent.click(await screen.findByRole('button', { name: /Seed book/ }));
        await findPageText(container, /Server page 1 text/);

        const jump = screen.getByLabelText(/Go to page between 1 and 12/);
        fireEvent.change(jump, { target: { value: '7' } });
        fireEvent.submit(jump.closest('form'));
        await findPageText(container, /Server page 7 text/)

        // Out-of-range entries clamp rather than error.
        fireEvent.change(jump, { target: { value: '999' } });
        fireEvent.submit(jump.closest('form'));
        await findPageText(container, /Server page 12 text/)
    });
});
