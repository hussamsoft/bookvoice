import { describe, expect, it } from 'vitest';
import { shouldZoomPdfWheel } from './pdfInteraction';

describe('PDF wheel interaction', () => {
    it('leaves plain wheel input available for document scrolling', () => {
        expect(shouldZoomPdfWheel({ deltaY: -120, ctrlKey: false })).toBe(false);
    });

    it('uses Ctrl+wheel as an intentional zoom gesture', () => {
        expect(shouldZoomPdfWheel({ deltaY: -120, ctrlKey: true })).toBe(true);
    });
});
