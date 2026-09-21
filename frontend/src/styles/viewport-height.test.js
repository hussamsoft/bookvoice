// F-19 — use dynamic viewport units on phone-targeted layouts.
//
// Pre-fix `.app-shell` and `.app-column` declared `height: 100vh`; on
// phones the URL bar collapsing on scroll reveals the background. The
// fix prefers `100dvh` with the legacy `100vh` as a fallback for
// browsers without dvh support.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_CSS = readFileSync(join(HERE, 'shell.css'), 'utf8');

function ruleBlock(selector) {
    const idx = SHELL_CSS.indexOf(selector);
    if (idx < 0) return null;
    const open = SHELL_CSS.indexOf('{', idx);
    if (open < 0) return null;
    let depth = 1;
    let close = open + 1;
    while (close < SHELL_CSS.length && depth > 0) {
        const ch = SHELL_CSS[close];
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        close += 1;
    }
    return SHELL_CSS.slice(open + 1, close - 1);
}

describe('viewport-height tokens (F-19)', () => {
    it('.app-shell prefers 100dvh with a 100vh fallback', () => {
        const body = ruleBlock('.app-shell');
        expect(body, '.app-shell rule not found').toBeTruthy();
        expect(body).toMatch(/height:\s*100dvh/);
        // Fallback for browsers without dvh support
        expect(body).toMatch(/height:\s*100vh/);
    });

    it('.app-column prefers 100dvh with a 100vh fallback', () => {
        const body = ruleBlock('.app-column');
        expect(body, '.app-column rule not found').toBeTruthy();
        expect(body).toMatch(/height:\s*100dvh/);
        expect(body).toMatch(/height:\s*100vh/);
    });
});
