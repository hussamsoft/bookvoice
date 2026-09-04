import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import App from './App';
import { ToastProvider } from './components/Toast';

// Mock child components to isolate App testing
vi.mock('./components/BookSession', () => ({
  default: () => <div data-testid="book-session-mock">Book Session Component</div>
}));

vi.mock('./components/PdfViewer', () => ({
  default: () => <div data-testid="pdf-viewer-mock">Pdf Viewer Component</div>
}));

vi.mock('./components/VoiceStudio', () => ({
  default: () => <div data-testid="voice-studio-mock">Voice Studio Component</div>
}));

vi.mock('./components/reader/Reader', () => ({
  default: () => <div data-testid="reader-mock">New Reader Component</div>
}));

function renderApp() {
  return render(
    <ToastProvider>
      <App />
    </ToastProvider>
  );
}

describe('App Component', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('renders correctly and defaults to PDF Mode', async () => {
    renderApp();
    expect(screen.getByText('BookVoice')).toBeInTheDocument();
    expect(await screen.findByTestId('pdf-viewer-mock')).toBeInTheDocument();
  });

  it('switches between PDF Mode and Camera Mode', async () => {
    renderApp();

    expect(await screen.findByTestId('pdf-viewer-mock')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'scanner mode' }));
    expect(await screen.findByTestId('book-session-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('pdf-viewer-mock')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'reader mode' }));
    expect(await screen.findByTestId('pdf-viewer-mock')).toBeInTheDocument();
  });

  it('exposes the reading-mode tablist in the title bar', async () => {
    renderApp();

    // The mode switcher is now a tablist in the title bar, not a separate
    // `<nav>` band; the dead `titlebar-palette` icon has been removed.
    expect(screen.getByRole('tablist', { name: 'Reading mode' })).toBeInTheDocument();
    expect(screen.queryByTestId('titlebar-palette')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'reader mode' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens Voice Studio as a third persistent workspace', async () => {
    renderApp();

    fireEvent.click(screen.getByRole('tab', { name: 'voice studio mode' }));

    expect(await screen.findByTestId('voice-studio-mock')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'voice studio mode' })).toHaveAttribute('aria-selected', 'true');
    expect(localStorage.getItem('bookvoice.app.mode')).toBe('studio');
  });


  it('keeps the production PdfViewer for the default and legacy reader flags', async () => {
    window.history.replaceState(null, '', '/?reader=old');
    renderApp();
    // Stage A keeps PdfViewer as the default; only `?reader=new` opts in.
    expect(await screen.findByTestId('pdf-viewer-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('reader-mock')).not.toBeInTheDocument();
  });

  it('mounts the new Reader behind ?reader=new', async () => {
    window.history.replaceState(null, '', '/?reader=new');
    renderApp();
    expect(await screen.findByTestId('reader-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('pdf-viewer-mock')).not.toBeInTheDocument();
  });

  it('opens the keyboard-shortcuts sheet from the ? key', async () => {
    renderApp();
    expect(await screen.findByTestId('pdf-viewer-mock')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: '?' });
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
  });

  it('supports arrow-key navigation between modes with roving tabindex', async () => {
    renderApp();

    const readerTab = screen.getByRole('tab', { name: 'reader mode' });
    const scannerTab = screen.getByRole('tab', { name: 'scanner mode' });
    const studioTab = screen.getByRole('tab', { name: 'voice studio mode' });

    // Reader starts active with tabindex=0, others -1
    expect(readerTab).toHaveAttribute('tabindex', '0');
    expect(scannerTab).toHaveAttribute('tabindex', '-1');

    // Focus reader, press ArrowRight -> scanner
    readerTab.focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(scannerTab).toHaveFocus();
    expect(scannerTab).toHaveAttribute('aria-selected', 'true');
    expect(readerTab).toHaveAttribute('tabindex', '-1');
    expect(scannerTab).toHaveAttribute('tabindex', '0');

    // ArrowRight again -> studio
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(studioTab).toHaveFocus();
    expect(studioTab).toHaveAttribute('aria-selected', 'true');

    // ArrowRight wraps to reader
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(readerTab).toHaveFocus();

    // ArrowLeft wraps to studio
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(studioTab).toHaveFocus();

    // Home -> reader
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' });
    expect(readerTab).toHaveFocus();

    // End -> studio
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' });
    expect(studioTab).toHaveFocus();
  });

});
