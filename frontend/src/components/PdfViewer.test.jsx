import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import PdfViewer from './PdfViewer';

globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

// Mock react-pdf to avoid canvas loading issues in JSDOM
vi.mock('react-pdf', () => ({
  Document: ({ children, onLoadSuccess }) => {
    useEffect(() => onLoadSuccess?.({ numPages: 3 }), [onLoadSuccess]);
    return <div data-testid="pdf-document-mock">{children}</div>;
  },
  Page: () => <div data-testid="pdf-page-mock">Page</div>,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}));

vi.mock('./Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() })
}));

describe('PdfViewer Component', () => {
  it('renders upload state initially', () => {
    const { unmount } = render(<PdfViewer />);
    expect(screen.getByRole('heading', { name: 'Start a listening session' })).toBeInTheDocument();
    expect(screen.getByText('Select PDF Book')).toBeInTheDocument();
    expect(screen.getByText('Open a text-based PDF to read and hear it in one place.')).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(document.documentElement).toHaveAttribute('lang', 'en');
    unmount();
  });

  it('renders the PDF control dock after the reading workspace', async () => {
    const { container } = render(<PdfViewer />);
    const input = container.querySelector('#pdf-upload');
    const pdf = new File(['pdf'], 'book.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [pdf] } });

    await waitFor(() => expect(container.querySelector('.pdf-toolbar')).toBeInTheDocument());
    expect(screen.getByRole('toolbar', { name: 'Reader navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reading options' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Narration player' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Original PDF' })).toBeInTheDocument();
    const workspace = container.querySelector('.pdf-layout');
    const toolbar = container.querySelector('.pdf-toolbar');
    expect(workspace.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps document zoom and follow controls beside page navigation', async () => {
    const { container } = render(<PdfViewer />);
    fireEvent.change(container.querySelector('#pdf-upload'), {
      target: { files: [new File(['pdf'], 'book.pdf', { type: 'application/pdf' })] },
    });

    const navigation = await screen.findByRole('toolbar', { name: 'Reader navigation' });
    expect(within(navigation).getByRole('button', { name: 'Zoom in' })).toBeVisible();
    expect(within(navigation).getByRole('checkbox', { name: 'Follow narration' })).toBeVisible();
  });

  it('scrolls normally and zooms only with Ctrl+wheel', async () => {
    const { container } = render(<PdfViewer />);
    fireEvent.change(container.querySelector('#pdf-upload'), {
      target: { files: [new File(['pdf'], 'book.pdf', { type: 'application/pdf' })] },
    });

    const scrollArea = await waitFor(() => {
      const area = container.querySelector('.pdf-scroll-area');
      expect(area).toBeInTheDocument();
      return area;
    });
    fireEvent.wheel(scrollArea, { deltaY: -120, clientX: 120, clientY: 120 });
    const navigation = screen.getByRole('toolbar', { name: 'Reader navigation' });
    expect(within(navigation).getByText('100%')).toBeVisible();
    fireEvent.wheel(scrollArea, { deltaY: -120, clientX: 120, clientY: 120, ctrlKey: true });
    await waitFor(() => expect(within(navigation).getByText('115%')).toBeVisible());
  });
});
