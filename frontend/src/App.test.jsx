import { render, screen, fireEvent } from '@testing-library/react';
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
        </div>
    ),
}));

vi.mock('./components/PdfViewer', () => ({
    default: () => <div data-testid="pdf-viewer-mock">Pdf Viewer Component</div>,
}));

vi.mock('./components/VoiceStudio', () => ({
    default: () => <div data-testid="voice-studio-mock">Voice Studio Component</div>,
}));

vi.mock('./components/reader/Reader', () => ({
    default: () => <div data-testid="reader-mock">New Reader Component</div>,
}));

// The gear dropdown is replaced by the Settings view in a later slice.
vi.mock('./components/SettingsPanel', () => ({
    default: () => <div data-testid="settings-panel-mock" />,
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
        expect(screen.getByRole('heading', { name: 'Read with your ears' })).toBeInTheDocument();
        const nav = screen.getByRole('navigation', { name: 'Main' });
        expect(nav).toBeInTheDocument();
        for (const label of ['Home', 'Library', 'Scan', 'Studio']) {
            expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
        }
        expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
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
    });

    it('opens a book from Home into the reader and remembers it', async () => {
        renderApp();

        fireEvent.click(screen.getByRole('button', { name: /Alice in Wonderland/ }));

        expect(await screen.findByTestId('pdf-viewer-mock')).toBeInTheDocument();
        expect(await screen.findByTestId('pdf-viewer-mock')).toBeInTheDocument();
        expect(localStorage.getItem('bookvoice.lastBook')).toBe('b1');
        expect(window.location.search).toBe('?book=b1');
    });

    it('opens a `?book=` deep link straight into the reader', async () => {
        window.history.replaceState(null, '', '/?book=b9');
        renderApp();
        expect(await screen.findByTestId('pdf-viewer-mock')).toBeInTheDocument();
    });

    it('keeps the production PdfViewer for the legacy reader flag', async () => {
        window.history.replaceState(null, '', '/?reader=old&book=b1');
        renderApp();
        expect(await screen.findByTestId('pdf-viewer-mock')).toBeInTheDocument();
        expect(screen.queryByTestId('reader-mock')).not.toBeInTheDocument();
    });

    it('mounts the new Reader behind ?reader=new', async () => {
        window.history.replaceState(null, '', '/?reader=new&book=b1');
        renderApp();
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
        const toggle = screen.getByRole('button', { name: 'Use light mode' });
        fireEvent.click(toggle);
        expect(document.documentElement).toHaveAttribute('data-mode', 'light');
        expect(localStorage.getItem('bookvoice.mode')).toBe('light');
    });
});
