// F-32 — refs written during render.
//
// `narrationRef.current = narration`, `sleepRef.current = sleep`,
// `openLibraryBookRef.current = openLibraryBook` (Reader.jsx),
// `onCloseRef.current = onClose` (Modal.jsx), and the two sync-refs in
// Transcript.jsx sat directly in component render bodies — documented
// unsafe under StrictMode/concurrent rendering. The codebase's strict
// 4-space style makes render-body statements exactly 4-indented, so the
// scan is decisive: anything at component-body indent that assigns
// `*Ref.current` is a violation; effect/callback bodies are deeper.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function* jsxFiles(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) yield* jsxFiles(full);
        else if (entry.name.endsWith('.jsx')) yield full;
    }
}

describe('no ref writes in render bodies (F-32)', () => {
    it('component files never assign `*Ref.current` at render-body indent', () => {
        const violations = [];
        for (const file of jsxFiles(SRC)) {
            const lines = readFileSync(file, 'utf8').split(/\r?\n/);
            lines.forEach((line, i) => {
                if (/^ {4}[A-Za-z]\w*[Rr]ef\.current\s*=/.test(line)) {
                    violations.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
                }
            });
        }
        expect(violations).toEqual([]);
    });
});
