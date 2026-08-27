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
    expect(screen.getByTestId('titlebar-sparkle')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'reader mode' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens Voice Studio as a third persistent workspace', async () => {
    renderApp();

    fireEvent.click(screen.getByRole('tab', { name: 'voice studio mode' }));

    expect(await screen.findByTestId('voice-studio-mock')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'voice studio mode' })).toHaveAttribute('aria-selected', 'true');
    expect(localStorage.getItem('bookvoice.app.mode')).toBe('studio');
  });

  it('restores the workspace selected on this device', async () => {
    localStorage.setItem('bookvoice.app.mode', 'studio');

    renderApp();

    expect(await screen.findByTestId('voice-studio-mock')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'voice studio mode' })).toHaveAttribute('aria-selected', 'true');
  });

});
