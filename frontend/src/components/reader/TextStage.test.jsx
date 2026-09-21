// F-12 — text books must render paragraph structure, not collapse to a
// single <p>.
//
// Pre-fix `TextStage` rendered `<p>{text}</p>` with no `white-space:
// pre-wrap`, so every blank-line boundary in a `.txt` / `.epub` / `.md`
// book vanished into a single space. The fix splits the text on blank
// lines into one <p> per paragraph.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import TextStage from './TextStage';

describe('TextStage paragraph structure (F-12)', () => {
    it('renders one <p> per blank-line-separated paragraph', () => {
        const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
        const { container } = render(
            <TextStage text={text} pageNumber={1} numPages={3} displayZoom={1} />
        );
        const paragraphs = container.querySelectorAll('.text-page-column p');
        expect(paragraphs.length).toBe(3);
        expect(paragraphs[0]).toHaveTextContent('First paragraph.');
        expect(paragraphs[1]).toHaveTextContent('Second paragraph.');
        expect(paragraphs[2]).toHaveTextContent('Third paragraph.');
    });

    it('preserves soft line wraps inside a single paragraph', () => {
        // A single newline is a soft wrap, not a paragraph break.
        const text = 'First line\nstill first.\n\nNew paragraph.';
        const { container } = render(
            <TextStage text={text} pageNumber={1} numPages={1} displayZoom={1} />
        );
        const paragraphs = container.querySelectorAll('.text-page-column p');
        expect(paragraphs.length).toBe(2);
        expect(paragraphs[0]).toHaveTextContent(/First line\s+still first\./);
    });

    it('renders the empty state for genuinely empty pages', () => {
        const { container } = render(
            <TextStage text="" pageNumber={4} numPages={10} displayZoom={1} />
        );
        expect(container.querySelector('.text-page-empty')).toBeInTheDocument();
        expect(container.querySelectorAll('.text-page-column p').length).toBe(0);
    });
});
