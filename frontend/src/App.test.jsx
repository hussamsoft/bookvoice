import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import App from './App';
import { ToastProvider } from './components/Toast';

// Mock the workspace components to isolate shell navigation testing.
vi.mock('./components/BookSession', () => ({
    default: (props) => (
        <div
            data-testid="book-session-mock"
            onClick={() => props.onDirty?.()}
        >
            Book Session Component
            <button type="button" onClick={(event) => { event.stopPropagation(); props.onSaved?.(); }}>mock-saved</button>
        </div>
    ),
}));

vi.mock('./components/VoiceStudio', () => ({
    default: () => <div data-testid="voice-studio-mock">Voice Studio Component</div>,
}));

vi.mock('./components/reader/Reader', () => ({
    default: () => <div data-testid="reader-mock">New Reader Component</div>,
}));
vi.mock('./components/UpdateBanner', () => ({
    default: () => <div data-testid="update-banner-mock">Update Banner Component</div>,
}));

// Library data for HomeView's continue-reading list.
vi.mock('./hooks/reader/usePreparedLibrary', () => ({
    usePreparedLibrary: () => ({
        books: [
            {
                id: 'b1',
                title: 'Alice in Wonderland',
                sourceKind: 'epub',
                pageCount: 12,
                progress: { page: 5, bookmarks: [] },
            },
            { id: 'b2', title: 'Fresh Book', sourceKind: 'pdf', pageCount: 4 },
        ],
        isLoading: false,
        refresh: vi.fn(),
        setBooks: vi.fn(),
    }),
}));

vi.mock('./hooks/useTtsStatus', () => ({
    useTtsStatus: () => ({
        modelReady: true,
        modelError: null,
        modelStatusDetail: '',
        deviceInfo: null,
        retryLoad: vi.fn(),
    }),
}));

function renderApp() {
    return render(
        <ToastProvider>
            <App />
        </ToastProvider>
    );
}

describe('App shell navigation', () => {
    beforeEach(() => {
        localStorage.clear();
        window.history.replaceState(null, '', '/');
    });

    it('lands on Home with the main navigation rail', () => {
        renderApp();
        expect(screen.getByRole('heading', { name: 'Turn any book into an audiobook' })).toBeInTheDocument();
        const nav = screen.getByRole('navigation', { name: 'Main' });
        expect(nav).toBeInTheDocument();
        for (const label of ['Home', 'Library', 'Scan', 'Studio']) {
            expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
        }
        expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    });

    it('mounts the update banner on every app view', () => {
        renderApp();
        expect(screen.getByTestId('update-banner-mock')).toBeInTheDocument();
    });

    it('navigates to Library, Scan, and Studio, persisting the view', async () => {
        renderApp();

        fireEvent.click(screen.getByRole('button', { name: 'Library' }));
        expect(await screen.findByRole('heading', { name: 'Library', level: 1 })).toBeInTheDocument();
        expect(localStorage.getItem('bookvoice.app.view')).toBe('library');
        expect(screen.getByRole('button', { name: 'Library' })).toHaveAttribute('aria-current', 'page');

        fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
        expect(await screen.findByTestId('book-session-mock')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Studio' }));
        expect(await screen.findByTestId('voice-studio-mock')).toBeInTheDocument();
        expect(localStorage.getItem('bookvoice.app.view')).toBe('studio');
        window.dispatchEvent(new CustomEvent('bookvoice:studio-project', { detail: { name: 'Demo voice project' } }));
        expect(await screen.findByText('Demo voice project')).toBeInTheDocument();
    });

    it('opens a book from Home into the reader and remembers it', async () => {
        renderApp();

        fireEvent.click(screen.getByRole('button', { name: /Alice in Wonderland/ }));

        expect(await screen.findByTestId('reader-mock')).toBeInTheDocument();
        expect(await screen.findByTestId('reader-mock')).toBeInTheDocument();
        expect(localStorage.getItem('bookvoice.lastBook')).toBe('b1');
        expect(window.location.search).toBe('?book=b1');
        expect(document.querySelector('.topbar-title')?.textContent).toBe('Alice in Wonderland');
    });

    it('opens a `?book=` deep link straight into the reader', async () => {
        window.history.replaceState(null, '', '/?book=b9');
        renderApp();
        expect(await screen.findByTestId('reader-mock')).toBeInTheDocument();
    });

    it('shows an explicit disabled return-to-book state after leaving Reader', async () => {
        renderApp();
        fireEvent.click(screen.getByRole('button', { name: /Alice in Wonderland/ }));
        await screen.findByTestId('reader-mock');
        fireEvent.click(screen.getByRole('button', { name: 'Library' }));
        await screen.findByRole('heading', { name: 'Library', level: 1 });
        expect(screen.getByRole('button', { name: 'Return to book' })).toBeDisabled();
    });

    it('opens a book deep link without a reader mode flag', async () => {
        window.history.replaceState(null, '', '/?reader=archive&book=b1');
        renderApp();
        expect(await screen.findByTestId('reader-mock')).toBeInTheDocument();
        expect(screen.queryByTestId('pdf-viewer-mock')).not.toBeInTheDocument();
    });

    it('mounts the new Reader by default (no flag set)', async () => {
        renderApp();
        fireEvent.click(screen.getByRole('button', { name: /Alice in Wonderland/ }));
        expect(await screen.findByTestId('reader-mock')).toBeInTheDocument();
        expect(screen.queryByTestId('pdf-viewer-mock')).not.toBeInTheDocument();
    });

    it('confirms before abandoning an unsaved scan session', async () => {
        renderApp();
        fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
        const scan = await screen.findByTestId('book-session-mock');

        // Capture a page (marks the session dirty), then try to leave.
        fireEvent.click(scan);
        fireEvent.click(screen.getByRole('button', { name: 'Library' }));

        const dialog = await screen.findByRole('dialog', { name: 'Leave the scan session?' });
        expect(dialog).toBeInTheDocument();

        // Staying keeps the scan session mounted.
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.getByTestId('book-session-mock')).toBeInTheDocument();
        expect(screen.queryByTestId('library-mock')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Library' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Leave without saving' }));
        expect(await screen.findByRole('heading', { name: 'Library', level: 1 })).toBeInTheDocument();
    });

    it('does not warn about unsaved work after a successful scan save (F-34)', async () => {
        renderApp();
        fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
        const scan = await screen.findByTestId('book-session-mock');

        fireEvent.click(scan);                       // capture -> dirty
        fireEvent.click(screen.getByRole('button', { name: 'mock-saved' })); // saved -> clean

        fireEvent.click(screen.getByRole('button', { name: 'Library' }));
        expect(await screen.findByRole('heading', { name: 'Library', level: 1 })).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Leave the scan session?' })).not.toBeInTheDocument();
    });

    it('keeps the top-bar title synced to the displayed view during the fade (F-40)', async () => {
        renderApp();
        fireEvent.click(screen.getByRole('button', { name: 'Library' }));

        // Mid-fade the stage still shows Home — so must the title.
        const stage = document.querySelector('.mode-stage');
        expect(stage.className).toContain('is-transitioning');
        expect(document.querySelector('.topbar-title').textContent).toBe('Home');

        // The swap rides the CSS fade's transitionend, not a JS timer.
        fireEvent.transitionEnd(stage, { propertyName: 'opacity' });
        await screen.findByRole('heading', { level: 1, name: 'Library' });
        expect(document.querySelector('.topbar-title').textContent).toBe('Library');
    });

    it('exposes exactly one banner landmark in every view (F-23)', async () => {
        renderApp();
        expect(screen.getAllByRole('banner')).toHaveLength(1);
        for (const label of ['Library', 'Scan', 'Studio', 'Settings']) {
            fireEvent.click(screen.getByRole('button', { name: label }));
            await waitFor(() => expect(screen.getAllByRole('banner')).toHaveLength(1));
        }
    });

    it('each real view renders exactly one h1 (F-24)', async () => {
        renderApp();
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

        fireEvent.click(screen.getByRole('button', { name: 'Library' }));
        await screen.findByRole('heading', { level: 1, name: 'Library' });
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

        fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
        await screen.findByRole('heading', { level: 1, name: 'Settings' });
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    });

    it('shows the Settings top-bar title and exposes a Settings nav button', async () => {
        renderApp();

        fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

        // The top-bar context title must surface the view's name; without
        // F-15's fix this resolves to '' (no entry in VIEW_TITLES).
        expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
        const topBarTitle = document.querySelector('.topbar-title');
        expect(topBarTitle?.textContent?.trim()).toBe('Settings');
    });

    it('opens the keyboard-shortcuts sheet from the ? key', async () => {
        renderApp();
        fireEvent.keyDown(window, { key: '?' });
        expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
    });

    it('shows the shared engine status chip in the top bar', () => {
        renderApp();
        const chip = screen.getByRole('status');
        expect(chip).toHaveTextContent('Voices ready');
        expect(chip.className).toContain('is-ready');
    });

    it('toggles light and dark mode from the top bar', () => {
        localStorage.setItem('bookvoice.mode', 'dark');
        renderApp();
        const toggle = screen.getByRole('button', { name: 'Switch to light mode' });
        fireEvent.click(toggle);
        expect(document.documentElement).toHaveAttribute('data-mode', 'light');
        expect(localStorage.getItem('bookvoice.mode')).toBe('light');
    });
});
