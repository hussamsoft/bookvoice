import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CSS parity guard: every className emitted from JSX (static strings,
 * template-literal branches, and classList calls) must have a matching
 * selector somewhere in src/styles/*.css. This exists because the 2026-08
 * design-system swap silently orphaned ~17 class names; this test makes
 * that failure mode impossible to repeat.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const STYLE_DIR = join(ROOT, 'src', 'styles');

const ALLOWLIST = new Set([
    // Bare state modifiers whose rules exist only as compounds elsewhere.
    'compact',
    // Third-party managed classes.
    'react-pdf__Page',
    'react-pdf__Document',
]);

function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry === 'node_modules' || entry === '__tests__') continue;
            walk(full, out);
        } else if (/\.(jsx|js)$/.test(entry) && !/\.test\./.test(entry)) {
            out.push(full);
        }
    }
    return out;
}

function extractClasses(source) {
    const found = new Set();
    // Static className="a b" / className={'a b'}
    for (const match of source.matchAll(/className=\{?"([^"}]+)"/g)) {
        for (const token of match[1].split(/\s+/)) found.add(token);
    }
    // Template literals: literal words plus quoted branch values, ignoring
    // comparison operands like mode === 'pdf'.
    for (const match of source.matchAll(/className=\{`([^`]*)`\}/g)) {
        const body = match[1].replace(/(?:===|!==)\s*['"][^'"]*['"]/g, '');
        for (const word of body.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
            if (/^[a-zA-Z][\w-]*$/.test(word) && !word.endsWith('-')) found.add(word);
        }
        for (const quoted of body.matchAll(/['"]([a-zA-Z][\w- ]*)['"]/g)) {
            for (const token of quoted[1].split(/\s+/)) {
                if (!token.endsWith('-')) found.add(token);
            }
        }
    }
    // classList.add/remove/toggle/contains('x')
    for (const match of source.matchAll(/classList\.\w+\(\s*['"]([\w-]+)['"]/g)) {
        found.add(match[1]);
    }
    return found;
}

function collectCssClassNames() {
    const names = new Set();
    for (const file of readdirSync(STYLE_DIR)) {
        if (!file.endsWith('.css')) continue;
        const css = readFileSync(join(STYLE_DIR, file), 'utf8');
        for (const match of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
            names.add(match[1]);
        }
    }
    return names;
}

describe('styles parity', () => {
    it('every JSX className resolves to a CSS selector', () => {
        const cssNames = collectCssClassNames();
        const missing = [];

        for (const file of walk(ROOT)) {
            const rel = relative(ROOT, file);
            const source = readFileSync(file, 'utf8');
            for (const name of extractClasses(source)) {
                if (!name || ALLOWLIST.has(name)) continue;
                if (!cssNames.has(name)) missing.push({ class: name, file: rel });
            }
        }

        expect(
            missing
                .map(({ class: c, file: f }) => `${c} (${f})`)
                .sort()
                .join('\n')
        ).toBe('');
    });

    it('defines the theme contract tokens both themes rely on', () => {
        const tokens = readFileSync(join(STYLE_DIR, 'tokens.css'), 'utf8');
        const count = (needle) => tokens.split(needle).length - 1;

        // Theme-independent structural tokens: declared once in :root.
        for (const token of [
            '--bg', '--surface', '--surface-raised', '--ink', '--ink-muted',
            '--hairline', '--accent', '--accent-ring', '--error', '--shadow-overlay',
            '--font-display', '--shadow-pop', '--ease-out-quart',
            '--text-2xl', '--text-3xl',
            '--control-h-sm', '--control-h-md', '--control-h-lg',
            '--z-raised', '--z-nav', '--z-panel', '--z-overlay', '--z-toast',
            '--bp-sm', '--bp-md',
            // Semantic type roles
            '--text-display', '--text-headline', '--text-title', '--text-subtitle',
            '--text-body', '--text-ui', '--text-caption', '--text-micro',
            // Line-heights
            '--leading-tight', '--leading-snug', '--leading-normal', '--leading-relaxed',
            // Semantic spacing
            '--gap-inline', '--gap-stack', '--gap-section', '--gap-group', '--gap-page',
            // Surface doctrine
            '--surface-card', '--border-hairline',
            // Motion extensions
            '--dur-slow', '--ease-in-out', '--ease-spring',
        ]) {
            expect(count(token)).toBeGreaterThanOrEqual(1);
        }

        // Themed tokens must be mapped per palette/mode combination.
        for (const token of ['--signal', '--signal-soft', '--signal-ring', '--live']) {
            expect(count(token)).toBeGreaterThanOrEqual(2);
        }

        expect(tokens).toContain('[data-mode="dark"]');
    });
});
