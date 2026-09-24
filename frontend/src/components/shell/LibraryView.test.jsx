import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../Toast';
import LibraryView from './LibraryView';

const books = [
    {
        id: 'b1',
        title: 'Alice in Wonderland',
        sourceKind: 'epub',
        pageCount: 12,
        progress: { page: 5, bookmarks: [] },
        profiles: [{ id: 'p1', readyPages: [1, 2, 3] }],
    },
];

vi.mock('../../hooks/reader/usePreparedLibrary', () => ({
    usePreparedLibrary: () => ({
        books,
        isLoading: false,
        refresh: vi.fn(async () => {}),
        setBooks: vi.fn(),
    }),
}));

// The app-wide config the library reads for prepare/export. Made mutable so
// the F-33 test can render with config still unresolved.
const configState = vi.hoisted(() => ({ current: { voice_id: 'v1', language_id: 'en' } }));
vi.mock('../../hooks/useUserConfig', () => ({
    useUserConfig: () => ({ config: configState.current, updateConfig: vi.fn() }),
}));

const prepareMock = vi.fn();
const archiveMock = vi.fn();
const audiobookMock = vi.fn();
vi.mock('../../hooks/useBookActions', () => ({
    useBookActions: () => ({
        jobs: {},
        prepareBook: prepareMock,
        exportArchive: archiveMock,
        exportAudiobook: audiobookMock,
        cancelJob: vi.fn(),
    }),
}));

const importMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/api', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, importPreparedBook: importMock };
});

function renderLibrary(props = {}) {
    return render(
        <ToastProvider>
            <LibraryView onOpenBook={vi.fn()} onError={vi.fn()} {...props} />
        </ToastProvider>,
    );
}

describe('LibraryView', () => {
    beforeEach(() => {
        prepareMock.mockReset();
        archiveMock.mockReset();
        audiobookMock.mockReset();
        importMock.mockReset();
    });

    it('lists books with their reading position', () => {
        renderLibrary();
        const row = screen.getAllByRole('button', { name: /Alice in Wonderland/ })
            .find((button) => button.className.includes('prepared-book-row'));
        expect(row).toHaveTextContent('Continue page 5');
    });

    it('keeps whole-book actions one level from the row', async () => {
        renderLibrary();

        fireEvent.click(screen.getByRole('button', { name: /Book actions for Alice/i }));
        fireEvent.click(screen.getByRole('button', { name: 'Prepare whole book' }));
        await waitFor(() => expect(prepareMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' })));

        fireEvent.click(screen.getByRole('button', { name: /Book actions for Alice/i }));
        fireEvent.click(screen.getByRole('button', { name: /save \.bookvoice file/i }));
        await waitFor(() => expect(archiveMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'b1' }), 'p1'));

        fireEvent.click(screen.getByRole('button', { name: /Book actions for Alice/i }));
        fireEvent.click(screen.getByRole('button', { name: 'Export audiobook' }));
        await waitFor(() => expect(audiobookMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'b1' }), 'p1'));
    });

    it('renders rows without a placeholder-fraction when the total is unknown (F-44)', () => {
        const savedPageCount = books[0].pageCount;
        books[0].pageCount = 0;
        try {
            const { container } = renderLibrary();
            const row = container.querySelector('.prepared-book-row');
            expect(row).not.toBeNull();
            expect(row).toHaveTextContent(/3 narrated/);
            expect(row.textContent).not.toMatch(/—/);
        } finally {
            books[0].pageCount = savedPageCount;
        }
    });

    it('disables book actions, without crashing, until config has loaded (F-33)', () => {
        configState.current = null;
        try {
            renderLibrary();
            // Pre-fix: clicking the trigger/prepare with config === null
            // reached `config.voice_id` in useBookActions and threw a
            // TypeError. Post-fix the trigger itself is not actionable.
            const trigger = screen.getByRole('button', { name: /Book actions for Alice/i });
            expect(trigger).toBeDisabled();
            fireEvent.click(trigger);
            expect(screen.queryByRole('group', { name: 'Book actions' })).not.toBeInTheDocument();
        } finally {
            configState.current = { voice_id: 'v1', language_id: 'en' };
        }
    });

    it('book-actions popover follows the shared keyboard pattern (F-27)', async () => {
        renderLibrary();
        const trigger = screen.getByRole('button', { name: /Book actions for Alice/i });
        fireEvent.click(trigger);

        const popover = screen.getByRole('group', { name: 'Book actions' });
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        // F-27: no ARIA menu roles without the full pattern — plain buttons.
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        // Open moves focus into the popover.
        expect(popover.contains(document.activeElement)).toBe(true);

        const items = Array.from(popover.querySelectorAll('button:not(:disabled)'));
        expect(items.length).toBe(4);
        fireEvent.keyDown(popover, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(items[1]);
        fireEvent.keyDown(popover, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(items[2]);
        fireEvent.keyDown(popover, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(items[3]);
        fireEvent.keyDown(popover, { key: 'ArrowDown' }); // wraps
        expect(document.activeElement).toBe(items[0]);
        fireEvent.keyDown(popover, { key: 'ArrowUp' }); // wraps back
        expect(document.activeElement).toBe(items[3]);
        fireEvent.keyDown(popover, { key: 'Home' });
        expect(document.activeElement).toBe(items[0]);
        fireEvent.keyDown(popover, { key: 'End' });
        expect(document.activeElement).toBe(items[3]);

        fireEvent.keyDown(popover, { key: 'Escape' });
        expect(screen.queryByRole('group', { name: 'Book actions' })).not.toBeInTheDocument();
        expect(document.activeElement).toBe(trigger);
    });

    it('shows the disabled-action reason as visible text, not only a tooltip (F-28)', async () => {
        // A book with no prepared profile: export rows are disabled.
        const withProfile = books[0].profiles;
        books[0].profiles = [];
        try {
            renderLibrary();
            fireEvent.click(screen.getByRole('button', { name: /Book actions for Alice/i }));
            const popover = screen.getByRole('group', { name: 'Book actions' });
            const hint = within(popover).getByText(/Prepare the book first/i);
            expect(hint).toBeInTheDocument();
            // The disabled buttons themselves must not be the only carrier.
            expect(hint.tagName).not.toBe('BUTTON');
        } finally {
            books[0].profiles = withProfile;
        }
    });

    it('closes the book-actions menu on an outside click', async () => {
        renderLibrary();

        fireEvent.click(screen.getByRole('button', { name: /Book actions for Alice/i }));
        expect(screen.getByRole('group', { name: 'Book actions' })).toBeInTheDocument();

        fireEvent.mouseDown(document.body);

        await waitFor(() => expect(
            screen.queryByRole('group', { name: 'Book actions' })
        ).not.toBeInTheDocument());
    });

    it('surfaces an add-book failure as a toast', async () => {
        importMock.mockRejectedValueOnce(new Error('PDF is corrupt'));
        renderLibrary();

        const input = document.querySelector('input[type="file"]');
        fireEvent.change(input, {
            target: { files: [new File(['x'], 'corrupt.pdf', { type: 'application/pdf' })] },
        });

        await waitFor(() =>
            expect(screen.getByText(/Could not add this book: PDF is corrupt/)).toBeInTheDocument()
        );
    });

    it('shows Adding… with a single spinner icon while importing (F-41)', async () => {
        importMock.mockImplementation(() => new Promise(() => {}));
        renderLibrary();

        const input = document.querySelector('input[type="file"]');
        fireEvent.change(input, {
            target: { files: [new File(['x'], 'book.pdf', { type: 'application/pdf' })] },
        });

        await waitFor(() => expect(screen.getByRole('button', { name: /Adding…/ })).toBeInTheDocument());
        const button = screen.getByRole('button', { name: /Adding…/ });
        expect(button.querySelectorAll('svg').length).toBe(1);
    });

    it('adds a book and opens it', async () => {
        const onOpenBook = vi.fn();
        importMock.mockResolvedValue({ id: 'b9', title: 'Imported', sourceKind: 'pdf' });
        renderLibrary({ onOpenBook });

        const input = document.querySelector('input[type="file"]');
        fireEvent.change(input, { target: { files: [new File(['x'], 'book.pdf', { type: 'application/pdf' })] } });

        await waitFor(() => expect(onOpenBook).toHaveBeenCalledWith(expect.objectContaining({ id: 'b9' })));
    });
});
