// F-31 — two focus-visibility defects in base.css:
//   1. `:focus-visible` set border-radius on the focused ELEMENT, so any
//      control without its own radius rule visibly changed shape when
//      keyboard focus arrived. The outline itself follows the element's
//      radius in modern browsers — the rewrite was never needed.
//   2. No `forced-colors` support at all on a Windows desktop app, where
//      High Contrast is a first-class mode: accent-tinted focus rings and
//      --accent-soft state fills both vanish.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const BASE_CSS = strip(readFileSync(join(HERE, 'base.css'), 'utf8'));

describe('focus ring geometry (F-31)', () => {
    it(':focus-visible styles only the outline, never the element shape', () => {
        const re = /:focus-visible\s*\{([^}]*)\}/g;
        const blocks = Array.from(BASE_CSS.matchAll(re), (m) => m[1]);
        expect(blocks.length).toBeGreaterThan(0);
        for (const body of blocks) {
            expect(body).not.toMatch(/border-radius/);
        }
    });
});

describe('forced-colors support (F-31)', () => {
    it('base.css declares a forced-colors block', () => {
        expect(BASE_CSS).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    });

    it('focus stays visible via system colours', () => {
        const start = BASE_CSS.indexOf('@media (forced-colors: active)');
        expect(start).toBeGreaterThan(-1);
        let depth = 0;
        let i = BASE_CSS.indexOf('{', start);
        const open = i;
        for (; i < BASE_CSS.length; i += 1) {
            if (BASE_CSS[i] === '{') depth += 1;
            else if (BASE_CSS[i] === '}') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        const body = BASE_CSS.slice(open + 1, i);
        expect(body).toMatch(/outline/);
        expect(body).toMatch(/Highlight/);
        // State must survive the flattening of background fills: active
        // elements get a system-colour outline/border instead.
        expect(body).toMatch(/CanvasText/);
    });
});
