/**
 * PdfStage — the PDF rendering surface for the migrated reader.
 *
 * Wraps the react-pdf Document/Page pair: the bundled pdf.js worker, the
 * text layer on (the highlight target), the annotation layer off, and zoom
 * applied as CSS `zoom` on the page wrapper over a fit-to-viewport page
 * width. The parent owns orchestration — adopting the loaded proxy,
 * learning the page count, and resolving page text — through
 * onDocumentLoad / onDocumentError.
 */
import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import {
    applyWordHighlight,
    buildWordSpanMap,
    splitTextLayerWordRuns,
} from '../../utils/pdfHighlight';
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export default function PdfStage({
    file,
    pageNumber,
    pageText = '',
    displayZoom,
    currentWord = -1,
    hasMeasuredTimings = false,
    onWordActivate,
    onDocumentLoad,
    onDocumentError,
}) {
    const [pageWidth, setPageWidth] = useState(null);
    const scrollRef = useRef(null);
    const textLayerRef = useRef(null);
    const wordSpanMapRef = useRef([]);
    const previousHighlightRef = useRef(null);
    useEffect(() => {
        const root = textLayerRef.current;
        const textLayer = root?.querySelector('.react-pdf__Page__textContent') || root;
        if (!textLayer) return;
        previousHighlightRef.current = null;
        wordSpanMapRef.current = [];
        if (!hasMeasuredTimings || !pageText) return;
        splitTextLayerWordRuns(textLayer);
        wordSpanMapRef.current = buildWordSpanMap(pageText.split(/\s+/).filter(Boolean), textLayer);
        wordSpanMapRef.current.forEach((span, index) => {
            if (span) span.dataset.wordIndex = String(index);
        });
    }, [pageNumber, pageText, hasMeasuredTimings]);

    useEffect(() => {
        const root = textLayerRef.current;
        const textLayer = root?.querySelector('.react-pdf__Page__textContent') || root;
        if (textLayer && hasMeasuredTimings) {
            applyWordHighlight(textLayer, wordSpanMapRef.current, currentWord, previousHighlightRef);
        }
    }, [currentWord, hasMeasuredTimings]);

    const activateWord = (event) => {
        const target = event.target.closest?.('.pdf-word-fragment');
        if (!target || !hasMeasuredTimings) return;
        onWordActivate?.(target.textContent, Number(target.dataset.wordIndex));
    };

    // Fit the page to the viewport width; the CSS `zoom` on the wrapper
    // then scales that fit width up or down — the same split that lets
    // useReaderZoom's displayZoom debounce avoid layout thrash on rapid
    // wheel ticks.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return undefined;
        const measure = () => setPageWidth(Math.floor(el.clientWidth) || null);
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        let frame = 0;
        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(measure);
        });
        observer.observe(el);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, [file]);

    return (
        <div className="pdf-scroll-area" ref={scrollRef}>
            {file ? (
                <Document
                    file={file}
                    onLoadSuccess={onDocumentLoad}
                    onLoadError={onDocumentError}
                    loading={(
                        <div className="pdf-loading" aria-busy="true">
                            <div className="skeleton skeleton--block skeleton--page" />
                        </div>
                    )}
                >
                    <div className="pdf-page-wrapper pdf-page-current" style={{ zoom: displayZoom }}>
                        <div
                            ref={textLayerRef}
                            className="react-pdf__Page__textContent"
                            onClick={activateWord}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    activateWord(event);
                                }
                            }}
                        >
                            <Page
                                pageNumber={pageNumber}
                                width={pageWidth || undefined}
                                renderAnnotationLayer={false}
                                renderTextLayer={true}
                                className="pdf-page-fit"
                                loading={<div className="skeleton skeleton--block skeleton--page" />}
                            />
                        </div>
                    </div>
                </Document>
            ) : (
                <div className="pdf-loading" role="status">Open a PDF to start reading.</div>
            )}
        </div>
    );
}
