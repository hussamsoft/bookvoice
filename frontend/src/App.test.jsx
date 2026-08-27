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

  it('provides named reading-mode navigation and keeps the sparkle mark', async () => {
    renderApp();

    expect(screen.getByRole('navigation', { name: 'Reading mode' })).toBeInTheDocument();
    expect(screen.queryByText('Local reader · Private by default')).not.toBeInTheDocument();
        expect(screen.getByTestId('titlebar-palette')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'reader mode' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens Voice Studio as a third persistent workspace', async () => {
    renderApp();

    fireEvent.click(screen.getByRole('tab', { name: 'voice studio mode' }));

    expect(await screen.findByTestId('voice-studio-mock')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'voice studio mode' })).toHaveAttribute('aria-selected', 'true');
    expect(localStorage.getItem('bookvoice.app.mode')).toBe('studio');
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
