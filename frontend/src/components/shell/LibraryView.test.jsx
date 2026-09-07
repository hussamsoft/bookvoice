import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

vi.mock('../../hooks/useUserConfig', () => ({
    useUserConfig: () => ({ config: { voice_id: 'v1', language_id: 'en' }, updateConfig: vi.fn() }),
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
        fireEvent.click(screen.getByRole('menuitem', { name: 'Prepare whole book' }));
        await waitFor(() => expect(prepareMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' })));

        fireEvent.click(screen.getByRole('button', { name: /Book actions for Alice/i }));
        fireEvent.click(screen.getByRole('menuitem', { name: /save \.bookvoice file/i }));
        await waitFor(() => expect(archiveMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'b1' }), 'p1'));

        fireEvent.click(screen.getByRole('button', { name: /Book actions for Alice/i }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Export audiobook' }));
        await waitFor(() => expect(audiobookMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'b1' }), 'p1'));
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
