# Documentation

These documents describe ChalanaMaya's behaviour. The P0 MVP and the P1 phase are implemented with React, strict TypeScript, Vite, HTML Canvas 2D, roughjs, and perfect-freehand; see the status table below.

## Index

- [Drawing tools](features/01-drawing-tools.md)
- [Styling](features/02-styling.md)
- [Selecting and arranging](features/03-selecting-arranging.md)
- [Canvas and view](features/04-canvas-and-view.md)
- [Save, open, and export](features/05-save-open-export.md)
- [Out of scope](out-of-scope.md)
- [Brand identity (approved)](brand-identity.md)

## Scope

In scope: a single-user whiteboard with drawing, styling, selection, canvas controls, local saving, and export. P0 features form the MVP; P1 and P2 remain planned work, not MVP promises. External embeds may need a network connection and permission from their providers.

Out of scope: collaboration, sharing services, encryption for shared sessions, libraries, AI tools, and app-level extras listed in [out of scope](out-of-scope.md). Local file export is not a hosted sharing service. Simple draw-to-shape recognition is an explicit drawing feature, not a generative AI feature.

## Feature tracking

Each feature heading has a permanent ID: DRAW, STYLE, ARR, VIEW, or FILE followed by a number. Never reuse or renumber an ID; mark retired features as retired. Descriptions explain intent and acceptance bullets define completion.

- **P0**: MVP must-have.
- **P1**: soon after MVP.
- **P2**: later.

All features start as **planned**. Track implementation in issues using the feature ID, priority, and status (planned, in progress, done, or deferred). Link evidence for every acceptance bullet before marking done. Update these specs when an approved decision changes behaviour; do not treat a priority as proof of completion.

## Implementation status

Phases P0 (MVP) and P1. Evidence: unit tests in `src/**/*.test.ts` and Playwright smoke tests in `e2e/smoke.spec.ts` (P0) and `e2e/p1.spec.ts` (P1). All P2 features remain **planned**.

| Area | P0 feature IDs (done) | P1 feature IDs (done) |
| --- | --- | --- |
| Drawing | DRAW-01, DRAW-02, DRAW-03, DRAW-04, DRAW-07, DRAW-08, DRAW-10, DRAW-17, DRAW-21 | DRAW-05, DRAW-06, DRAW-11, DRAW-12, DRAW-13, DRAW-15, DRAW-20, DRAW-22 |
| Styling | STYLE-01, STYLE-02, STYLE-05, STYLE-11, STYLE-12, STYLE-13 | STYLE-03, STYLE-04, STYLE-06, STYLE-07, STYLE-08, STYLE-09, STYLE-10, STYLE-14 |
| Selecting and arranging | ARR-01, ARR-02, ARR-03, ARR-04, ARR-05 | ARR-06, ARR-07, ARR-08, ARR-09, ARR-10, ARR-11, ARR-12, ARR-13, ARR-14 |
| Canvas and view | VIEW-01, VIEW-02, VIEW-03, VIEW-12, VIEW-13, VIEW-16 | VIEW-04, VIEW-06, VIEW-07, VIEW-08, VIEW-09, VIEW-10, VIEW-11, VIEW-14, VIEW-15 |
| Save, open, and export | FILE-01, FILE-02, FILE-03, FILE-08, FILE-10 | FILE-04, FILE-05, FILE-06, FILE-07 |
| Everything else (P2) | — | planned |

P1 notes: pictures are inserted from the main menu ("Insert picture…"), by paste, or by drop; links accept only http(s), mailto and in-board `#el=` targets, and unsafe links are dropped when a file is opened; embedded board data in PNG (`tEXt` chunk) and SVG (`<metadata id="chalanamaya-scene">`) is validated, and damaged data is refused without touching the board; preferences (input preference, pen mode) are kept under `chalanamaya.prefs`.

Review round 2 fixes: style changes made while typing are part of the single text-edit undo step (VIEW-12 with STYLE-11/12/13 and DRAW-10); Ctrl/⌘ + wheel zoom is capped at 1.2× per event (VIEW-02); handle resizing follows the pointer delta (ARR-03); drags are cancelled on window blur and pointer cancel; dialogs return focus to the control that opened them; switching theme autosaves the board settings; an unreadable autosaved board is kept under `chalanamaya.board.unreadable` instead of being overwritten (FILE-01).

Known limits: images are stored as data URLs inside the single localStorage entry, so a large photo can exceed the browser quota (the storage warning then appears); moving files to IndexedDB is left for a later phase. Right-aligned auto-width text grows leftwards from the click point by design.
