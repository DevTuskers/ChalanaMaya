# Documentation

These documents describe planned behaviour, not working features. No technology stack is selected.

## Index

- [Drawing tools](features/01-drawing-tools.md)
- [Styling](features/02-styling.md)
- [Selecting and arranging](features/03-selecting-arranging.md)
- [Canvas and view](features/04-canvas-and-view.md)
- [Save, open, and export](features/05-save-open-export.md)
- [Out of scope](out-of-scope.md)
- [Brand identity: proposal needing owner approval](brand-identity.md)

## Scope

In scope: a single-user whiteboard with drawing, styling, selection, canvas controls, local saving, and export. P0 features form the MVP; P1 and P2 remain planned work, not MVP promises. External embeds may need a network connection and permission from their providers.

Out of scope: collaboration, sharing services, encryption for shared sessions, libraries, AI tools, and app-level extras listed in [out of scope](out-of-scope.md). Local file export is not a hosted sharing service. Simple draw-to-shape recognition is an explicit drawing feature, not a generative AI feature.

## Feature tracking

Each feature heading has a permanent ID: DRAW, STYLE, ARR, VIEW, or FILE followed by a number. Never reuse or renumber an ID; mark retired features as retired. Descriptions explain intent and acceptance bullets define completion.

- **P0**: MVP must-have.
- **P1**: soon after MVP.
- **P2**: later.

All features start as **planned**. Track implementation in issues using the feature ID, priority, and status (planned, in progress, done, or deferred). Link evidence for every acceptance bullet before marking done. Update these specs when an approved decision changes behaviour; do not treat a priority as proof of completion.
