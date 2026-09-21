// F-06 — modal scrim must darken the page in both light AND dark mode.
//
// Pre-fix `.modal-overlay` consumed `color-mix(in srgb, var(--ink) 45%, transparent)`.
// `--ink` is near-black in light mode and near-white in dark mode, so opening a
// dialog in dark mode brightened the page instead of dimming it. The fix
// routes the scrim through a dedicated `--scrim` token that stays dark in
// both modes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = readFileSync(join(HERE, 'tokens.css'), 'utf8');
const CONTROLS_CSS = readFileSync(join(HERE, 'controls.css'), 'utf8');

describe('modal scrim token (F-06)', () => {
    it('tokens.css declares --scrim', () => {
        expect(TOKENS_CSS).toMatch(/--scrim\s*:/);
    });

    it('.modal-overlay consumes --scrim, not the inverted --ink mix', () => {
        const ruleMatch = CONTROLS_CSS.match(/\.modal-overlay\s*\{([\s\S]*?)\}/);
        expect(ruleMatch, '.modal-overlay rule not found').toBeTruthy();
        const body = ruleMatch[1];
        expect(body).toMatch(/background\s*:\s*var\(--scrim\)/);
        expect(body).not.toMatch(/color-mix[^;]*var\(--ink\)/);
    });
});
