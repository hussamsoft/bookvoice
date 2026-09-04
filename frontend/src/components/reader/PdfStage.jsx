/**
 * PdfStage — the PDF rendering surface.
 *
 * Structural placeholder for Stage A.8. The actual react-pdf Document +
 * Page wiring lives in the production PdfViewer.jsx, which stays the
 * default reader until the port is signed off. The full port —
 * including the worker URL, text-layer highlighting, and the wheel/pan
 * handlers — lands when the TTS pipeline is moved out of PdfViewer.jsx
 * (a multi-day refactor that needs the TTS backend to test).
 */
import { useEffect, useRef } from 'react';

export default function PdfStage({
    file,
    pageNumber,
    displayZoom,
    onWheel,
}) {
    const containerRef = useRef(null);
    useEffect(() => {
        if (!containerRef.current || !onWheel) return;
        const el = containerRef.current;
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [onWheel]);

    return (
        <div className="pdf-scroll-area" ref={containerRef}>
            {file ? (
                <div
                    className="pdf-page-wrapper pdf-page-current pdf-stage-placeholder"
                    style={{ zoom: displayZoom }}
                    role="img"
                    aria-label={`PDF page ${pageNumber} placeholder`}
                >
                    <p>PdfStage (new) — Phase A.8 placeholder. Real react-pdf Document + Page land when the TTS pipeline is ported.</p>
                </div>
            ) : (
                <div className="pdf-loading" role="status">
                    Open a PDF to start reading.
                </div>
            )}
        </div>
    );
}
