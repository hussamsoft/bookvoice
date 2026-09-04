/**
 * TextStage — the plain-text book view (EPUB / TXT / MD).
 *
 * The page text comes from props (resolved by `useReaderPageLifecycle` in
 * the parent); this component is a presentational wrapper that applies
 * the displayZoom and provides a sensible paper-and-ink reading column.
 */
export default function TextStage({ text, pageNumber, numPages, displayZoom }) {
    if (!text) {
        return (
            <div className="text-page-empty" role="status">
                <p>No text for page {pageNumber} yet.</p>
            </div>
        );
    }
    return (
        <div
            className="text-page-column"
            style={{ zoom: displayZoom }}
            aria-label={`Page ${pageNumber} of ${numPages}`}
        >
            <p>{text}</p>
        </div>
    );
}
