// F-16 — one documented touch-target standard.
//
// Pre-fix: four different sizes claimed to be "the" standard. The ≤720px
// override shrank `.btn-compact` to 36px and, coming later in the file,
// beat the `@media (pointer: coarse)` 44px rule on phones; range inputs
// and checkboxes were absent from the coarse block entirely; and the
// styles-parity ALLOWLIST carried a bare 'compact' entry masking the
// PlaybackControls alias drift.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLS_CSS = readFileSync(join(HERE, 'controls.css'), 'utf8');
const PARITY_TEST = readFileSync(join(HERE, 'styles-parity.test.js'), 'utf8');

function mediaBlocks(condition) {
    const out = [];
    let from = 0;
    for (;;) {
        const start = CONTROLS_CSS.indexOf(condition, from);
        if (start < 0) break;
        const open = CONTROLS_CSS.indexOf('{', start);
        let depth = 1;
        let i = open + 1;
        while (i < CONTROLS_CSS.length && depth > 0) {
            if (CONTROLS_CSS[i] === '{') depth += 1;
            else if (CONTROLS_CSS[i] === '}') depth -= 1;
            i += 1;
        }
        out.push(CONTROLS_CSS.slice(open + 1, i - 1));
        from = i;
    }
    return out;
}

function mediaBlock(condition) {
    const blocks = mediaBlocks(condition);
    expect(blocks.length, `media block ${condition} not found`).toBeGreaterThan(0);
    return blocks.join('\n');
}

describe('touch targets (F-16)', () => {
    it('the coarse-pointer block covers range inputs and checkboxes', () => {
        const coarse = mediaBlock('@media (pointer: coarse)');
        expect(coarse).toMatch(/input\[type="range"\]/);
        expect(coarse).toMatch(/input\[type="checkbox"\]/);
    });

    it('the ≤720px override holds compact buttons at 44px, not 36px', () => {
        const narrow = mediaBlock('@media (max-width: 720px)');
        const compactRule = narrow.match(/\.btn-compact,[\s\S]*?\.btn\.btn-compact\s*\{([^}]*)\}/);
        expect(compactRule, 'compact override not found in the ≤720px block').toBeTruthy();
        expect(compactRule[1]).toMatch(/--control-h-lg/);
        expect(compactRule[1]).not.toMatch(/--control-h-md/);
    });

    it('the parity allowlist no longer masks the bare compact alias', () => {
        expect(PARITY_TEST).not.toMatch(/^\s*'compact',\s*$/m);
    });
});
