# Documentation

These documents describe ChalanaMaya's behaviour. The P0 MVP is implemented with React, strict TypeScript, Vite, HTML Canvas 2D, roughjs, and perfect-freehand; see the status table below.

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

Phase P0 (MVP). Evidence: unit tests in `src/**/*.test.ts` and Playwright smoke tests in `e2e/smoke.spec.ts`. All P1 and P2 features remain **planned**.

| Area | Feature IDs | Status |
| --- | --- | --- |
| Drawing | DRAW-01, DRAW-02, DRAW-03, DRAW-04, DRAW-07, DRAW-08, DRAW-10, DRAW-17, DRAW-21 | done |
| Styling | STYLE-01, STYLE-02, STYLE-05, STYLE-11, STYLE-12, STYLE-13 | done |
| Selecting and arranging | ARR-01, ARR-02, ARR-03, ARR-04, ARR-05 | done |
| Canvas and view | VIEW-01, VIEW-02, VIEW-03, VIEW-12, VIEW-13, VIEW-16 | done |
| Save, open, and export | FILE-01, FILE-02, FILE-03, FILE-08, FILE-10 | done |
| Everything else (P1, P2) | — | planned |
