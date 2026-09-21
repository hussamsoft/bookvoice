// F-21 — `.prepared-book-row` is a clickable book opener but never declared
// `cursor: pointer`, so it reads as inert text. (The covers half of F-21 is
// explicitly out of scope — see tasks/fix-2.8.1/FINDINGS.md "Deferred".)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const READER_CSS = readFileSync(join(HERE, 'reader.css'), 'utf8');

function ruleBlock(source, selector) {
    // Exact-match the selector at the start of a rule (not a descendant).
    const re = new RegExp(`(^|[}\\n])\\s*${selector.replace(/[.[]/g, (m) => '\\' + m).replace(/\]/g, '\\]')}\\s*\\{`, 'm');
    const m = re.exec(source);
    if (!m) return null;
    const open = source.indexOf('{', m.index);
    let depth = 1;
    let close = open + 1;
    while (close < source.length && depth > 0) {
        if (source[close] === '{') depth += 1;
        else if (source[close] === '}') depth -= 1;
        close += 1;
    }
    return source.slice(open + 1, close - 1);
}

describe('prepared-book-row cursor (F-21)', () => {
    it('.prepared-book-row declares cursor: pointer', () => {
        const body = ruleBlock(READER_CSS, '.prepared-book-row');
        expect(body, '.prepared-book-row rule not found').toBeTruthy();
        expect(body).toMatch(/cursor:\s*pointer/);
    });
});
