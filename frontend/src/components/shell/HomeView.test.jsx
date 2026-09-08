import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import HomeView from './HomeView';

vi.mock('../../hooks/reader/usePreparedLibrary', () => ({
    usePreparedLibrary: () => ({
        books: HomeView.__books ?? [],
        isLoading: false,
        refresh: vi.fn(async () => {}),
        setBooks: vi.fn(),
    }),
}));

const importMock = vi.fn();
vi.mock('../../utils/api', () => ({
    importPreparedBook: (...args) => importMock(...args),
}));

function renderHome(props = {}) {
    return render(
        <HomeView
            lastBookId={null}
            onOpenBook={vi.fn()}
            onNavigate={vi.fn()}
            onError={vi.fn()}
            {...props}
        />
    );
}

describe('HomeView', () => {
    it('invites a brand-new user to add their first book', () => {
        renderHome();
        expect(screen.getByRole('heading', { name: 'Turn any book into an audiobook' })).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /Add a book/ }).length).toBeGreaterThan(0);
        expect(screen.queryByText('Continue reading')).not.toBeInTheDocument();
    });

    it('leads with the last opened book under Continue reading', () => {
        HomeView.__books = [
            { id: 'a', title: 'Odyssey', sourceKind: 'pdf', pageCount: 24, progress: { page: 9, bookmarks: [] } },
            { id: 'b', title: 'Iliad', sourceKind: 'epub', pageCount: 4, progress: { page: 2, bookmarks: [] } },
        ];
        renderHome({ lastBookId: 'b' });

        const rows = screen.getAllByRole('button', { name: /Iliad|Odyssey/ });
        expect(rows[0]).toHaveTextContent('Iliad');
        expect(rows[0]).toHaveTextContent('Continue page 2');
    });

    it('opens a book from the continue-reading list', async () => {
        HomeView.__books = [
            { id: 'a', title: 'Odyssey', sourceKind: 'pdf', progress: { page: 9, bookmarks: [] } },
        ];
        const onOpenBook = vi.fn();
        renderHome({ onOpenBook });

        fireEvent.click(screen.getByRole('button', { name: /Odyssey/ }));
        expect(onOpenBook).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'a' })
        );
    });

    it('adds a book through the file input and opens it', async () => {
        HomeView.__books = [];
        const onOpenBook = vi.fn();
        importMock.mockResolvedValue({ id: 'new1', title: 'Imported', sourceKind: 'pdf' });
        renderHome({ onOpenBook });

        const input = document.querySelector('input[type="file"]');
        expect(input).not.toBeNull();
        const file = new File(['x'], 'book.pdf', { type: 'application/pdf' });
        await waitFor(async () => {
            fireEvent.change(input, { target: { files: [file] } });
        });

        await waitFor(() => expect(onOpenBook).toHaveBeenCalledWith(expect.objectContaining({ id: 'new1' })));
        expect(importMock).toHaveBeenCalledTimes(1);
    });

    it('navigates to the scanner and the studio from the quick actions', () => {
        const onNavigate = vi.fn();
        renderHome({ onNavigate });

        fireEvent.click(screen.getByRole('button', { name: 'Open scanner' }));
        expect(onNavigate).toHaveBeenCalledWith('scan');
        fireEvent.click(screen.getByRole('button', { name: 'Open Studio' }));
        expect(onNavigate).toHaveBeenCalledWith('studio');
    });
});
