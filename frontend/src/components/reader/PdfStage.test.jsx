import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PdfStage from './PdfStage';

describe('PdfStage', () => {
    it('prompts to open a PDF when no file is loaded', () => {
        render(<PdfStage file={null} pageNumber={1} displayZoom={1} />);
        expect(screen.getByText('Open a PDF to start reading.')).toBeInTheDocument();
    });

    it('renders the current page placeholder for a loaded file', () => {
        render(<PdfStage file={{}} pageNumber={3} displayZoom={1.25} />);
        expect(screen.getByRole('img', { name: 'PDF page 3 placeholder' })).toBeInTheDocument();
    });

    it('attaches the wheel handler to the scroll area for ctrl+wheel zoom', () => {
        const onWheel = vi.fn();
        const { container } = render(
            <PdfStage file={null} pageNumber={1} displayZoom={1} onWheel={onWheel} />
        );
        fireEvent.wheel(container.querySelector('.pdf-scroll-area'), {
            deltaY: -120,
            ctrlKey: true,
        });
        expect(onWheel).toHaveBeenCalledTimes(1);
    });
});
