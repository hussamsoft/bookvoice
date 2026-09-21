import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PdfStage from './PdfStage';

vi.mock('react-pdf', () => ({
    Document: ({ children, onLoadSuccess }) => {
        useEffect(() => {
            onLoadSuccess?.({ numPages: 3 });
        }, [onLoadSuccess]);
        return <div data-testid="pdf-document-mock">{children}</div>;
    },
    Page: (props) => (
        <div
            data-testid="pdf-page-mock"
            data-page-number={props.pageNumber}
            data-text-layer={String(props.renderTextLayer)}
            data-annotation-layer={String(props.renderAnnotationLayer)}
        >
            PDF page
        </div>
    ),
    pdfjs: { GlobalWorkerOptions: { workerSrc: '' } },
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.mjs' }));

// The stage measures its viewport with ResizeObserver; jsdom has none.
globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
};

describe('PdfStage', () => {
    it('prompts to open a PDF when no file is loaded', () => {
        render(<PdfStage file={null} pageNumber={1} displayZoom={1} />);
        expect(screen.getByText('Open a PDF to start reading.')).toBeInTheDocument();
        expect(screen.queryByTestId('pdf-document-mock')).not.toBeInTheDocument();
    });

    it('renders the Document/Page pair and reports the loaded proxy', () => {
        const onDocumentLoad = vi.fn();
        render(
            <PdfStage
                file={{ name: 'book.pdf' }}
                pageNumber={2}
                displayZoom={1.25}
                onDocumentLoad={onDocumentLoad}
            />
        );
        expect(screen.getByTestId('pdf-document-mock')).toBeInTheDocument();
        const page = screen.getByTestId('pdf-page-mock');
        expect(page).toHaveAttribute('data-page-number', '2');
        expect(page).toHaveAttribute('data-text-layer', 'true');
        expect(page).toHaveAttribute('data-annotation-layer', 'false');
        expect(onDocumentLoad).toHaveBeenCalledWith({ numPages: 3 });
    });

    it('coalesces resize bursts into a single pending measure per frame (F-44)', () => {
        let observerCallback = null;
        globalThis.ResizeObserver = class {
            constructor(cb) { observerCallback = cb; }
            observe() {}
            disconnect() {}
        };
        const pending = new Map();
        let nextHandle = 0;
        const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((fn) => {
            nextHandle += 1;
            pending.set(nextHandle, fn);
            return nextHandle;
        });
        const cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((handle) => {
            pending.delete(handle);
        });
        try {
            render(<PdfStage file={{ name: 'book.pdf' }} pageNumber={1} displayZoom={1} />);
            expect(observerCallback).toBeTruthy();
            // Dragging a window edge fires a burst of observations; the old
            // wiring measured (and re-rendered the page) synchronously per
            // one. Now at most ONE measure may be in flight per frame.
            for (let i = 0; i < 5; i += 1) observerCallback([]);
            expect(pending.size).toBe(1);
            for (const fn of pending.values()) fn();
        } finally {
            rafSpy.mockRestore();
            cafSpy.mockRestore();
            globalThis.ResizeObserver = class {
                observe() {}
                disconnect() {}
            };
        }
    });
});
