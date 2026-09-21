// F-04 — the reader toolbar must wrap on narrow viewports.
//
// Pre-fix: `.reader-toolbar-row` was `display: inline-flex; gap: …;` with no
// `flex-wrap`. At < ~1225 px the inline-flex row of ~20 controls overflowed
// its container's `overflow-x: clip` and search / sleep / zoom / fit became
// permanently unreachable. The fix makes the toolbar wrap unconditionally,
// so every control is visible regardless of viewport width.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const READER_CSS = readFileSync(join(HERE, 'reader.css'), 'utf8');

function ruleBlock(selector) {
    // Naive but adequate: grab the `{ … }` immediately after the selector.
    const idx = READER_CSS.indexOf(selector);
    if (idx < 0) throw new Error(`selector not found: ${selector}`);
    const open = READER_CSS.indexOf('{', idx);
    if (open < 0) throw new Error(`no rule body for ${selector}`);
    let depth = 1;
    let close = open + 1;
    while (close < READER_CSS.length && depth > 0) {
        const ch = READER_CSS[close];
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        close += 1;
    }
    return READER_CSS.slice(open + 1, close - 1);
}

describe('reader toolbar layout (F-04)', () => {
    it('.reader-toolbar-row declares flex-wrap: wrap', () => {
        const body = ruleBlock('.reader-toolbar-row');
        // Order-independent: split on `;` and look for the declaration.
        const decls = body
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean);
        const wrap = decls.find((d) => /^flex-wrap\s*:/.test(d));
        expect(wrap, 'flex-wrap declaration missing from .reader-toolbar-row').toBeDefined();
        expect(wrap.split(':')[1].trim().toLowerCase()).toBe('wrap');
    });

    it('no media-query rule pins the toolbar to a single row', () => {
        // The 2.8.0 stylesheet carried a `@media (max-width: 720px) { … }`
        // block targeting the dead `.reader-navigation` and `.reader-nav-primary`
        // classes. Even though the rule itself was a no-op (those classes
        // vanished with PdfViewer.jsx), it has now been retargeted to the
        // live `.reader-toolbar-row` selector. Make sure the media-query
        // block mentions the live selector and not just dead ones.
        const mediaBlocks = [...READER_CSS.matchAll(/@media[^{]+\{([\s\S]*?)\n\}/g)];
        expect(mediaBlocks.length, 'no @media block found in reader.css').toBeGreaterThan(0);
        const wrapsSomething = mediaBlocks.some((m) =>
            /\.reader-toolbar-row\b/.test(m[1])
        );
        expect(
            wrapsSomething,
            'no @media block in reader.css wraps .reader-toolbar-row'
        ).toBe(true);
    });
});
