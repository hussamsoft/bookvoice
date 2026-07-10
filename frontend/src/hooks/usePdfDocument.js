import { useCallback, useRef } from 'react';
import { pdfjs } from 'react-pdf';
import { extractTextFromImage } from '../utils/ocr';
import { cleanExtractedText } from '../utils/cleanup';

/**
 * PDF document loading, text extraction, and OCR helpers.
 */
export function usePdfDocument({ file, fileRef, toast }) {
    const pdfDocRef = useRef(null);
    const textCacheRef = useRef(new Map());

    const adoptPdfDocument = useCallback((pdf) => {
        pdfDocRef.current = pdf || null;
    }, []);

    const cachePageText = useCallback((pageNum, text) => {
        if (Number.isInteger(pageNum) && pageNum > 0 && String(text || '').trim()) {
            textCacheRef.current.set(pageNum, String(text).trim());
        }
    }, []);

    const getPdfDocument = useCallback(async () => {
        if (pdfDocRef.current) return pdfDocRef.current;
        const f = fileRef.current || file;
        if (!f) throw new Error('No PDF loaded');
        const arrayBuffer = await f.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        pdfDocRef.current = pdf;
        return pdf;
    }, [file, fileRef]);

    const extractTextFromPage = async (pdf, pageNum) => {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const items = textContent.items
            .filter((item) => item.str != null)
            .map((item) => {
                const t = item.transform || [1, 0, 0, 1, 0, 0];
                return { str: item.str, x: t[4], y: t[5] };
            });
        items.sort((a, b) => {
            const dy = b.y - a.y;
            if (Math.abs(dy) > 4) return dy;
            return a.x - b.x;
        });
        return items
            .map((i) => i.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    };

    const renderPageToDataUrl = async (pdf, pageNum, scale = 1.5) => {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        return canvas.toDataURL('image/jpeg', 0.92);
    };

    const preparePageText = useCallback(
        async (pageNum, { forceOcr = false, quiet = false, setIsOcring } = {}) => {
            if (!forceOcr && textCacheRef.current.has(pageNum)) {
                return textCacheRef.current.get(pageNum);
            }
            const pdf = await getPdfDocument();
            let text = '';
            if (!forceOcr) {
                text = await extractTextFromPage(pdf, pageNum);
            }
            if (!text.trim() || forceOcr) {
                if (!quiet && setIsOcring) setIsOcring(true);
                try {
                    if (!quiet && toast) {
                        toast.info(
                            forceOcr
                                ? 'Running OCR on this page…'
                                : 'No embedded text — running OCR…'
                        );
                    }
                    const dataUrl = await renderPageToDataUrl(pdf, pageNum);
                    const raw = await extractTextFromImage(dataUrl);
                    text = cleanExtractedText(raw);
                } finally {
                    if (!quiet && setIsOcring) setIsOcring(false);
                }
            }
            if (!text.trim()) {
                throw new Error('No text found on this page.');
            }
            textCacheRef.current.set(pageNum, text);
            return text;
        },
        [getPdfDocument, toast]
    );

    const findTextInDocument = useCallback(
        async (query, startPage = 1) => {
            const needle = String(query || '').trim().toLocaleLowerCase();
            if (!needle) return null;
            const pdf = await getPdfDocument();
            const first = Math.max(1, Math.min(pdf.numPages, Number(startPage) || 1));
            for (let offset = 0; offset < pdf.numPages; offset++) {
                const pageNum = ((first - 1 + offset) % pdf.numPages) + 1;
                const cached = textCacheRef.current.get(pageNum);
                const text = cached || await extractTextFromPage(pdf, pageNum);
                if (text.toLocaleLowerCase().includes(needle)) return pageNum;
            }
            return null;
        },
        [getPdfDocument]
    );

    const invalidateTextCache = useCallback((pageNum) => {
        if (pageNum != null) {
            textCacheRef.current.delete(pageNum);
        } else {
            textCacheRef.current.clear();
        }
    }, []);

    const resetDocument = useCallback(() => {
        pdfDocRef.current = null;
        textCacheRef.current.clear();
    }, []);

    return {
        adoptPdfDocument,
        cachePageText,
        pdfDocRef,
        textCacheRef,
        getPdfDocument,
        findTextInDocument,
        preparePageText,
        invalidateTextCache,
        resetDocument,
    };
}
