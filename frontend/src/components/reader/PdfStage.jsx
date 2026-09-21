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

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export default function PdfStage({
    file,
    pageNumber,
    displayZoom,
    onDocumentLoad,
    onDocumentError,
}) {
    const scrollRef = useRef(null);
    const [pageWidth, setPageWidth] = useState(null);

    // Fit the page to the viewport width; the CSS `zoom` on the wrapper
    // then scales that fit width up or down — the same split that lets
    // useReaderZoom's displayZoom debounce avoid layout thrash on rapid
    // wheel ticks.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return undefined;
        const measure = () => setPageWidth(Math.floor(el.clientWidth) || null);
        measure();
        // ResizeObserver may not exist in jsdom tests.
        if (typeof ResizeObserver === 'undefined') return undefined;
        // F-44: coalesce resize bursts into one setState per frame — dragging
        // a window edge used to re-render the whole PDF page per observation.
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
                        <Page
                            pageNumber={pageNumber}
                            width={pageWidth || undefined}
                            renderAnnotationLayer={false}
                            renderTextLayer={true}
                            className="pdf-page-fit"
                            loading={<div className="skeleton skeleton--block skeleton--page" />}
                        />
                    </div>
                </Document>
            ) : (
                <div className="pdf-loading" role="status">Open a PDF to start reading.</div>
            )}
        </div>
    );
}
