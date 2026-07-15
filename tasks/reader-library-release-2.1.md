# BookVoice 2.1 reader-library release

## Objective

Make the installed Windows reader feel durable and predictable: PDF navigation behaves like a document viewer, generated narration survives app restarts, bookmarks are visible and actionable, preparation is resumable page-by-page, and the reader offers polished speed and theme controls without changing narration quality.

## Acceptance criteria

- Plain mouse-wheel input scrolls the PDF; zoom requires the explicit controls or `Ctrl+wheel`.
- Pointer drag pans the actual document surface in both axes and preserves the page position.
- Every completed full-page narration for a library book is atomically promoted into its voice/language profile and is reused after reopening the app.
- Whole-book preparation records every completed page immediately, skips valid pages on resume, and never publishes a partial page.
- The library and in-book toolbar show bookmark pages, current progress, and prepared-page counts; selecting a bookmark opens it.
- Playback speed is an accessible select with 0.75x, 1x, 1.25x, 1.5x, and 2x options.
- A persisted light/dark theme toggle updates the full application shell.
- The built-in voice is labeled `BookVoice Natural`.
- The active narrated word is highlighted in both the transcript and the PDF text layer whenever the narrated page is visible.
- The title bar keeps the sparkle icon and removes the privacy slogan.
- Preparation optimizations may remove redundant work and improve scheduling, but may not change model, synthesis, or alignment quality settings.

## Implementation boundaries

- Always: preserve the current accurate word-pronunciation and full-timing playback behavior; use atomic file replacement/checksums; add regression tests; validate packaged runtime.
- Ask first: changing model weights, synthesis parameters, or introducing a new dependency.
- Never: save chunk/partial WAVs as completed pages, discard valid prepared pages on cancellation, or make wheel zoom the default.

## Commands

- Frontend tests: `cd frontend && npm test`
- Frontend lint/build: `cd frontend && npm run lint && npm run build`
- Backend tests: `python -m pytest -q`
- Portable/MSI release: `python build.py --msi --per-user`
- Packaged smoke: `python scripts/smoke_launch.py --app-dir dist`

## Verification

- Unit tests cover wheel intent, speed selection, bookmark summaries, theme persistence, PDF word mapping, completed-page persistence, cancellation, and preparation resume.
- Full frontend/backend suites, lint, production build, release packaging, and packaged smoke all pass before commit/push.
