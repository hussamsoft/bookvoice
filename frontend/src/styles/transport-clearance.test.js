// F-10 — the fixed mobile transport bar overlays content; every surface
// that hosts it must pad its scroll area clear of the bar.
//
// Pre-fix only `.pdf-viewer-container` (the Reader root — which, before
// Phase 2, didn't even render the transport) got the padding, while
// `.book-session` (the scan flow, which DOES render it) had none, so the
// bar occluded the bottom of every scan session on phones. Also, the dead
// `--transport-height: 76px` token disagreed with the real
// `--transport-fixed-h` formula and had zero consumers.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const READER_CSS = readFileSync(join(HERE, 'reader.css'), 'utf8');
const TOKENS_CSS = readFileSync(join(HERE, 'tokens.css'), 'utf8');

describe('mobile transport clearance (F-10)', () => {
    it('book-session and pdf-viewer-container both clear the fixed transport at ≤720px', () => {
        // Find the ≤720px block that carries the transport padding and
        // assert both hosts are in its selector list.
        const blocks = [...READER_CSS.matchAll(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/g)]
            .map((m) => m[1]);
        const padded = blocks.filter((b) => b.includes('--transport-fixed-h'));
        expect(padded.length, 'no ≤720px block pads for --transport-fixed-h').toBeGreaterThan(0);
        const combined = padded.join('\n');
        expect(combined).toMatch(/\.pdf-viewer-container/);
        expect(combined).toMatch(/\.book-session/);
    });

    it('the dead --transport-height token is gone', () => {
        expect(TOKENS_CSS).not.toMatch(/--transport-height\s*:/);
    });
});
