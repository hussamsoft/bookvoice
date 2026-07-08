import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import App from './App';

// Mock child components to isolate App testing
vi.mock('./components/BookSession', () => ({
  default: () => <div data-testid="book-session-mock">Book Session Component</div>
}));

vi.mock('./components/PdfViewer', () => ({
  default: () => <div data-testid="pdf-viewer-mock">Pdf Viewer Component</div>
}));

describe('App Component', () => {
  it('renders correctly and defaults to PDF Mode', () => {
    render(<App />);
    expect(screen.getByText('BookVoice')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-viewer-mock')).toBeInTheDocument();
  });

  it('switches between PDF Mode and Camera Mode', () => {
    render(<App />);

    // Initial state is PDF Mode
    expect(screen.getByTestId('pdf-viewer-mock')).toBeInTheDocument();

    // Switch to Camera Mode
    fireEvent.click(screen.getByText('Camera Mode'));
    expect(screen.getByTestId('book-session-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('pdf-viewer-mock')).not.toBeInTheDocument();

    // Switch back to PDF Mode
    fireEvent.click(screen.getByText('PDF Mode'));
    expect(screen.getByTestId('pdf-viewer-mock')).toBeInTheDocument();
  });
});
