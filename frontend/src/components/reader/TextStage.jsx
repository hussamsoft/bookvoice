/**
 * TextStage — the plain-text book view (EPUB / TXT / MD).
 *
 * The page text comes from props (resolved by `useReaderPageLifecycle` in
 * the parent); this component is a presentational wrapper that applies
 * the displayZoom and provides a sensible paper-and-ink reading column.
 *
 * Paragraph structure: the page text is split on blank-line boundaries
 * (one or more blank lines between non-empty lines). A single newline
 * inside a paragraph is preserved as a soft wrap (CSS does the visual
 * wrapping); the structural break is the blank line. Real <p> elements
 * get real paragraph margins and selection behaviour; `text-indent` and
 * `text-align` continue to work for first-line styling.
 */
function splitParagraphs(text) {
    return String(text || '')
        .split(/\n\s*\n+/)
        .map((para) => para.replace(/\n+/g, ' ').trim())
        .filter((para) => para.length > 0);
}

export default function TextStage({ text, pageNumber, numPages, displayZoom, isLoading }) {
    // Loading the next page must not look like an empty result. Render a
    // skeleton while the page is being resolved; show the empty state only
    // when the fetch has completed and the page is genuinely empty. (F-09.)
    if (isLoading) {
        return (
            <div
                className="text-page-column text-page-column--loading"
                data-testid="reader-page-skeleton"
                aria-busy="true"
                aria-label={`Loading page ${pageNumber} of ${numPages}`}
            >
                <div className="skeleton skeleton--block" aria-hidden="true" />
                <div className="skeleton skeleton--block" aria-hidden="true" />
                <div className="skeleton skeleton--block skeleton--short" aria-hidden="true" />
            </div>
        );
    }
    if (!text) {
        return (
            <div className="text-page-empty" role="status" data-testid="reader-page-empty">
                <p>No text for page {pageNumber} yet.</p>
            </div>
        );
    }
    const paragraphs = splitParagraphs(text);
    return (
        <div
            className="text-page-column"
            style={{ zoom: displayZoom }}
            aria-label={`Page ${pageNumber} of ${numPages}`}
        >
            {paragraphs.map((paragraph, index) => (
                // The paragraph index is a stable enough key here: the
                // page text itself is stable within a render, and React
                // only needs the key for diffing across re-renders.
                <p key={index}>{paragraph}</p>
            ))}
        </div>
    );
}
