import React, { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import PdfViewer from './PdfViewer';
import { resolvePageContent } from '../utils/pageContentResolver';

globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

// Stable fake transport so scrubber wiring can be asserted through seekTo.
const transportMock = vi.hoisted(() => ({
  currentTime: 0,
  cycleRate: vi.fn(),
  duration: 0,
  isPlaying: false,
  mediaError: '',
  playbackRate: 1,
  refresh: vi.fn(),
  seekTo: vi.fn(),
  setRate: vi.fn(),
  skipBy: vi.fn(),
  toggle: vi.fn(),
}));

// Capture PlaybackControls props to assert the optional scrubber contract.
const playbackProps = vi.hoisted(() => ({ current: null }));

const librarySeed = vi.hoisted(() => ({ books: [] }));

vi.mock('../hooks/useAudioTransport', () => ({
  useAudioTransport: () => transportMock,
}));

vi.mock('./PlaybackControls', () => ({
  default: (props) => {
    playbackProps.current = props;
    return null;
  },
}));

const makeLibraryBook = (index) => ({
  id: `book-${index}`,
  title: `Prepared volume ${index}`,
  sourceKind: 'pdf',
  pageCount: 10,
  progress: { page: index + 1, bookmarks: [2, 7] },
});

vi.mock('../utils/api', async (importOriginal) => ({
  ...(await importOriginal()),
  listPreparedBooks: vi.fn(() => Promise.resolve(librarySeed.books)),
  importPreparedBook: vi.fn(() => Promise.resolve({
    id: 'text-book-1',
    title: 'Text book',
    sourceKind: 'txt',
    pageCount: 5,
  })),
}));

vi.mock('../utils/pageContentResolver', () => ({
  preparedPageAudioEntry: vi.fn(() => null),
  // Default: a page fetch that never settles, so pending states hold.
  resolvePageContent: vi.fn(() => new Promise(() => {})),
}));

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
  beforeEach(() => {
    playbackProps.current = null;
    transportMock.seekTo.mockClear();
    librarySeed.books = [];
  });

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
    // The options panel owns its trigger now; it opens its own popover/sheet.
    const optionsTrigger = screen.getByRole('button', { name: 'Reading options' });
    expect(optionsTrigger).toHaveAttribute('aria-expanded', 'false');
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

  it('lists every prepared book in a scrollable area instead of capping at five', async () => {
    librarySeed.books = Array.from({ length: 7 }, (_, index) => makeLibraryBook(index));
    const { container } = render(<PdfViewer />);

    const rows = await waitFor(() => {
      const found = container.querySelectorAll('.prepared-library .prepared-book-row');
      expect(found.length).toBe(7);
      return found;
    });
    expect(rows[6]).toHaveTextContent('Prepared volume 6');
    expect(rows[6]).toHaveTextContent('Bookmarks 2, 7');

    const scrollArea = container.querySelector('.prepared-library-list');
    expect(scrollArea).not.toBeNull();
  });

  it('routes scrubber seeks through the transport with a null-safe duration', async () => {
    const { container } = render(<PdfViewer />);
    fireEvent.change(container.querySelector('#pdf-upload'), {
      target: { files: [new File(['pdf'], 'book.pdf', { type: 'application/pdf' })] },
    });

    const props = await waitFor(() => {
      expect(playbackProps.current).not.toBeNull();
      return playbackProps.current;
    });
    expect(props.onSeek).toBeTypeOf('function');
    // No streamed playlist yet, so the whole-book duration is unknown.
    expect(props.duration ?? null).toBeNull();

    act(() => props.onSeek(42.5));
    expect(transportMock.seekTo).toHaveBeenCalledWith(42.5);
  });

  it('shows text-line skeletons while a text-book page is fetching', async () => {
    let releaseFetch;
    resolvePageContent.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFetch = resolve; })
    );
    const { container } = render(<PdfViewer />);
    fireEvent.change(container.querySelector('#pdf-upload'), {
      target: { files: [new File(['hello'], 'book.txt', { type: 'text/plain' })] },
    });

    const bars = await waitFor(() => {
      const found = container.querySelectorAll('.skeleton.skeleton--line');
      expect(found.length).toBeGreaterThanOrEqual(6);
      return found;
    });
    expect(container.querySelector('[aria-busy="true"]')).toContainElement(bars[0]);

    await act(async () => releaseFetch({ text: 'The page text arrives.', source: 'server', prepared: null }));
    await waitFor(() => expect(container.querySelector('.skeleton--line')).toBeNull());
    expect(container.textContent).toContain('The page text arrives.');
  });
});
