import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import PdfViewer from './PdfViewer';

// Mock react-pdf to avoid canvas loading issues in JSDOM
vi.mock('react-pdf', () => ({
  Document: ({ children }) => <div data-testid="pdf-document-mock">{children}</div>,
  Page: () => <div data-testid="pdf-page-mock">Page</div>,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}));

vi.mock('./Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() })
}));

describe('PdfViewer Component', () => {
  it('renders upload state initially', () => {
    render(<PdfViewer />);
    expect(screen.getByText('Select PDF Book')).toBeInTheDocument();
  });
});
