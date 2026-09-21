// F-16 — collapse the `.compact` alias on PlaybackControls transport buttons.
//
// Pre-fix the secondary-row transport buttons used `className="btn secondary
// compact"`. CSS selectors `.btn.compact` resolved to 28px instead of the
// coarse-pointer 44px the audit promised, because the rule lived in
// controls.css but `.btn`'s `min-height` from the same file won on cascade
// order. The fix replaces `.compact` with the aliased `.btn-compact` so
// every interactive control meets the 44px coarse-pointer target.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAYBACK_CSS_SRC = readFileSync(join(HERE, 'PlaybackControls.jsx'), 'utf8');

describe('PlaybackControls transport-button class (F-16)', () => {
    it('does not use the .btn.compact alias for any transport button', () => {
        // Look for `className="btn secondary compact"` (with no hyphen)
        // anywhere in PlaybackControls.jsx. The compact alias is now
        // `.btn-compact`; this rule keeps the broken form from sneaking
        // back in.
        const matches = PLAYBACK_CSS_SRC.match(/className="btn[^"]*\bcompact\b[^"]*"/g) || [];
        // Filter out `.is-compact` (a separate toggle on the wrapper,
        // unrelated to the touch-target rule) and `.btn-compact` (the
        // fixed alias) — both are valid.
        const aliasUsage = matches.filter(
            (s) => !/\bis-compact\b/.test(s) && !/\bbtn-compact\b/.test(s)
        );
        expect(aliasUsage, `unexpected .btn.compact usage: ${aliasUsage.join(', ')}`).toEqual([]);
    });
});
