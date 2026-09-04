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
});
