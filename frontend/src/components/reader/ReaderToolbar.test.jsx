import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ReaderToolbar from './ReaderToolbar';

const baseProps = {
    pageNumber: 3,
    numPages: 12,
    pageJumpInput: '3',
    onPageJumpInput: () => {},
    onPageJumpSubmit: () => {},
    onGoToPage: () => {},
    onTogglePlay: () => {},
    isPlaying: false,
    zoom: 1,
    onZoom: () => {},
    followNarration: true,
    onFollowNarration: () => {},
    searchQuery: '',
    onSearchQuery: () => {},
    onSearchSubmit: () => {},
    isSearching: false,
    bookmarks: [],
    onToggleBookmark: () => {},
    isExporting: false,
    onExportThroughCurrentPage: () => {},
};

function renderToolbar(props = {}) {
    return render(<ReaderToolbar {...baseProps} {...props} />);
}

describe('ReaderToolbar tier 1', () => {
    it('keeps bookmarks one click away: toggle and jump sit beside page nav', () => {
        const onGoToPage = vi.fn();
        const onToggleBookmark = vi.fn();
        renderToolbar({ bookmarks: [2, 7], onGoToPage, onToggleBookmark });

        fireEvent.click(screen.getByRole('button', { name: 'Bookmark page 3' }));
        expect(onToggleBookmark).toHaveBeenCalledTimes(1);

        fireEvent.change(screen.getByRole('combobox', { name: 'Go to bookmark' }), {
            target: { value: '7' },
        });
        expect(onGoToPage).toHaveBeenCalledWith(7);
    });

    it('returns to the Library through the back button', () => {
        const onBack = vi.fn();
        renderToolbar({ onBack });

        fireEvent.click(screen.getByRole('button', { name: /library/i }));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('labels the follow toggle Auto-turn pages', () => {
        renderToolbar();
        expect(screen.getByRole('checkbox', { name: 'Auto-turn pages' }).checked).toBe(true);
    });
});

describe('ReaderToolbar Book menu', () => {
    it('opens one level deep with find, range export, and whole-book actions', () => {
        const onPrepare = vi.fn();
        const onCreatePreparedFile = vi.fn();
        renderToolbar({
            canPrepareBook: true,
            onPrepareWholeBook: onPrepare,
            hasProfile: true,
            onCreatePreparedFile,
        });

        fireEvent.click(screen.getByRole('button', { name: 'Book menu' }));
        const menu = screen.getByRole('group', { name: 'Whole book' });

        fireEvent.click(within(menu).getByRole('button', { name: 'Prepare whole book' }));
        expect(onPrepare).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'Book menu' }));
        fireEvent.click(within(screen.getByRole('group', { name: 'Whole book' }))
            .getByRole('button', { name: /save \.bookvoice file/i }));
        expect(onCreatePreparedFile).toHaveBeenCalledTimes(1);
    });

    it('locks exports behind a prepared profile instead of hiding them', () => {
        renderToolbar({ canPrepareBook: true, hasProfile: false });
        fireEvent.click(screen.getByRole('button', { name: 'Book menu' }));

        const save = screen.getByRole('button', { name: /save \.bookvoice file/i });
        const exportAudiobook = screen.getByRole('button', { name: 'Export audiobook' });
        expect(save).toBeDisabled();
        expect(exportAudiobook).toBeDisabled();
        expect(save.getAttribute('title')).toMatch(/prepare the book first/i);
    });

    it('switches to a cancel control with progress while exporting', () => {
        const cancel = vi.fn();
        renderToolbar({
            canPrepareBook: true,
            hasProfile: true,
            isExportingAudiobook: true,
            audiobookProgress: { jobId: 'j', pagesDone: 2, pageCount: 5 },
            onCancelExportAudiobook: cancel,
        });
        fireEvent.click(screen.getByRole('button', { name: 'Book menu' }));

        fireEvent.click(screen.getByRole('button', { name: /cancel export \(2\/5\)/i }));
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('offers range export from page 2 with a real dash', () => {
        renderToolbar({ pageNumber: 4 });
        fireEvent.click(screen.getByRole('button', { name: 'Book menu' }));

        expect(screen.getByRole('button', { name: 'Export 1–4' })).toBeInTheDocument();
    });

    it('explains the wait instead of hiding range export on page 1', () => {
        renderToolbar({ pageNumber: 1 });
        fireEvent.click(screen.getByRole('button', { name: 'Book menu' }));

        expect(screen.getByText(/play it to export its audio/i)).toBeInTheDocument();
    });
});
