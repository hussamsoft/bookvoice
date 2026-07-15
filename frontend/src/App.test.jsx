import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import App from './App';
import { ToastProvider } from './components/Toast';

// Mock child components to isolate App testing
vi.mock('./components/BookSession', () => ({
  default: () => <div data-testid="book-session-mock">Book Session Component</div>
}));

vi.mock('./components/PdfViewer', () => ({
  default: () => <div data-testid="pdf-viewer-mock">Pdf Viewer Component</div>
}));

function renderApp() {
  return render(
    <ToastProvider>
      <App />
    </ToastProvider>
  );
}

describe('App Component', () => {
  it('renders correctly and defaults to PDF Mode', async () => {
    renderApp();
    expect(screen.getByText('BookVoice')).toBeInTheDocument();
    expect(await screen.findByTestId('pdf-viewer-mock')).toBeInTheDocument();
  });

  it('switches between PDF Mode and Camera Mode', async () => {
    renderApp();

    expect(await screen.findByTestId('pdf-viewer-mock')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Scan a page' }));
    expect(await screen.findByTestId('book-session-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('pdf-viewer-mock')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'PDF reader' }));
    expect(await screen.findByTestId('pdf-viewer-mock')).toBeInTheDocument();
  });

  it('provides named reading-mode navigation and keeps the sparkle mark', async () => {
    renderApp();

    expect(screen.getByRole('navigation', { name: 'Reading mode' })).toBeInTheDocument();
    expect(screen.queryByText('Local reader · Private by default')).not.toBeInTheDocument();
    expect(screen.getByTestId('titlebar-sparkle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PDF reader' })).toHaveAttribute('aria-pressed', 'true');
  });
});
