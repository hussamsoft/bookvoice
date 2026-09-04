import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Reader from './Reader';

// Keep the library fetch offline: the real util would fire a live
// request at the dev API from jsdom.
vi.mock('../../utils/api', () => ({
    listPreparedBooks: vi.fn(async () => []),
}));

describe('Reader', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('renders the empty TextStage when no page is loaded', () => {
        render(<Reader />);
        expect(screen.getByText(/No text for page 1 yet/)).toBeInTheDocument();
    });

    it('toggles a bookmark for the current page via useBookmarks', () => {
        render(<Reader />);
        const toggle = screen.getByRole('button', { name: /bookmark page 1/i });
        fireEvent.click(toggle);
        expect(screen.getByRole('button', { name: /remove bookmark from page 1/i })).toBeInTheDocument();
        expect(screen.getByText(/Bookmarks: 1/)).toBeInTheDocument();
    });

    it('zooms in / out / fit via useReaderZoom', async () => {
        render(<Reader />);
        expect(screen.getByText('100%')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
        // displayZoom lags `zoom` by 80 ms (debounce).
        await waitFor(() => expect(screen.getByText('115%')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
        await waitFor(() => expect(screen.getByText('130%')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
        await waitFor(() => expect(screen.getByText('115%')).toBeInTheDocument());
        fireEvent.click(screen.getByText('Fit'));
        await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument());
    });

    it('reports a status line when search finds no match', async () => {
        render(<Reader />);
        const input = screen.getByLabelText(/find in book/i);
        fireEvent.change(input, { target: { value: 'unfindable' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        expect(await screen.findByText(/No matches for .unfindable./)).toBeInTheDocument();
        // No navigation happened: the empty TextStage is still there.
        expect(screen.getByText(/No text for page 1 yet/)).toBeInTheDocument();
    });

    it('jumps to the page where a search matches', async () => {
        render(<Reader />);
        const input = screen.getByLabelText(/find in book/i);
        fireEvent.change(input, { target: { value: 'Page 5' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        expect(await screen.findByText(/Found .Page 5. on page 5/)).toBeInTheDocument();
        await screen.findByText(/Page 5 placeholder text/);
    });

    it('loads a page via useReaderPageLifecycle (Read button)', async () => {
        render(<Reader />);
        fireEvent.click(screen.getByRole('button', { name: 'Read' }));
        await waitFor(() => {
            expect(screen.getByText(/Page 1 placeholder text/)).toBeInTheDocument();
        });
    });

    it('navigates pages via the Previous / Next buttons', async () => {
        render(<Reader />);
        const prev = screen.getByRole('button', { name: 'Previous page' });
        const next = screen.getByRole('button', { name: 'Next page' });
        expect(prev).toBeDisabled();

        fireEvent.click(next);
        await screen.findByText(/Page 2 placeholder text/);
        fireEvent.click(prev);
        await screen.findByText(/Page 1 placeholder text/);
        expect(prev).toBeDisabled();
    });

    it('navigates pages via the PageUp / PageDown / Home / End keys', async () => {
        render(<Reader />);
        fireEvent.keyDown(window, { key: 'PageDown' });
        await screen.findByText(/Page 2 placeholder text/);
        fireEvent.keyDown(window, { key: 'End' });
        await screen.findByText(/Page 100 placeholder text/);
        expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
        fireEvent.keyDown(window, { key: 'Home' });
        await screen.findByText(/Page 1 placeholder text/);
    });

    it('offers Resume / Start fresh after browsing away from the narrated page', async () => {
        render(<Reader />);
        fireEvent.click(screen.getByRole('button', { name: 'Read' }));
        await screen.findByText(/Page 1 placeholder text/);

        // One page away stays inside the no-dialog window.
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        await screen.findByText(/Page 2 placeholder text/);
        expect(screen.queryByRole('dialog', { name: /resume or start fresh/i })).not.toBeInTheDocument();

        // Two pages away offers the choice; Resume returns to the page
        // the reader was narrating.
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        const dialog = await screen.findByRole('dialog', { name: /resume or start fresh/i });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Resume' }));
        await screen.findByText(/Page 1 placeholder text/);
    });

    it('starts fresh on the current page from the resume dialog', async () => {
        render(<Reader />);
        fireEvent.click(screen.getByRole('button', { name: 'Read' }));
        await screen.findByText(/Page 1 placeholder text/);
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        await screen.findByText(/Page 2 placeholder text/);
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        const dialog = await screen.findByRole('dialog', { name: /resume or start fresh/i });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Start fresh' }));
        await screen.findByText(/Page 3 placeholder text/);
        expect(screen.queryByRole('dialog', { name: /resume or start fresh/i })).not.toBeInTheDocument();
    });

    it('persists nothing while the scaffold has no document identity', async () => {
        render(<Reader />);
        fireEvent.click(screen.getByRole('button', { name: 'Read' }));
        fireEvent.click(screen.getByRole('button', { name: /bookmark page 1/i }));
        await screen.findByText(/Page 1 placeholder text/);
        // Reading progress autosave stays disabled until A.8 wires a real
        // document id, so no placeholder key leaks into localStorage.
        expect(localStorage.getItem('bookvoice:reader:placeholder-doc')).toBeNull();
    });

    it('exposes the library loading status from usePreparedLibrary', () => {
        render(<Reader />);
        expect(screen.getByText(/Loading library/)).toBeInTheDocument();
    });

    it('toggles the bookmark via the B keyboard shortcut', () => {
        render(<Reader />);
        expect(screen.getByText(/No bookmarks yet/)).toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'b' });
        expect(screen.getByText(/Bookmarks: 1/)).toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'b' });
        expect(screen.getByText(/No bookmarks yet/)).toBeInTheDocument();
    });
});
