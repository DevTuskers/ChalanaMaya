# Documentation

These documents describe ChalanaMaya's behaviour. The P0 MVP and the P1 phase are implemented with React, strict TypeScript, Vite, HTML Canvas 2D, roughjs, and perfect-freehand; see the status table below.

## Index

- [Drawing tools](features/01-drawing-tools.md)
- [Styling](features/02-styling.md)
- [Selecting and arranging](features/03-selecting-arranging.md)
- [Canvas and view](features/04-canvas-and-view.md)
- [Save, open, and export](features/05-save-open-export.md)
- [Sessions and agents](features/06-sessions-and-agents.md) (planned)
- [Media](features/07-media.md) (planned)
- [Plan: board sessions, agent drawing and media](plans/agent-canvas.md)
- [Out of scope](out-of-scope.md)
- [Brand identity (approved)](brand-identity.md)

## Scope

In scope: a single-user whiteboard with drawing, styling, selection, canvas controls, local saving, and export. P0 features form the MVP; P1 and P2 remain planned work, not MVP promises. External embeds may need a network connection and permission from their providers.

Planned next (see the [agent canvas plan](plans/agent-canvas.md)): board sessions at `/s/<id>` stored by a ChalanaMaya server with live board-session sync, a built-in MCP server so agents can draw on a session, and GIF, video and animated CSS component items.

Out of scope: collaboration features (accounts, permissions, cursors, comments), hosted sharing services, encryption for shared sessions, libraries, built-in AI generation, and app-level extras listed in [out of scope](out-of-scope.md). Local file export is not a hosted sharing service. Simple draw-to-shape recognition is an explicit drawing feature, not a generative AI feature.

## Feature tracking

Each feature heading has a permanent ID: DRAW, STYLE, ARR, VIEW, FILE, SESS, AGENT, or MEDIA followed by a number. Never reuse or renumber an ID; mark retired features as retired. Descriptions explain intent and acceptance bullets define completion.

- **P0**: MVP must-have.
- **P1**: soon after MVP.
- **P2**: later.

All features start as **planned**. Track implementation in issues using the feature ID, priority, and status (planned, in progress, done, or deferred). Link evidence for every acceptance bullet before marking done. Update these specs when an approved decision changes behaviour; do not treat a priority as proof of completion.

## Implementation status

Phases P0 (MVP), P1, P2 (round 1) and agent-canvas phase 1a. Evidence: unit tests in `src/**/*.test.ts` and Playwright smoke tests in `e2e/smoke.spec.ts` (P0), `e2e/p1.spec.ts` (P1), `e2e/revision.spec.ts` (P1 review fixes), `e2e/p2.spec.ts` (P2) and `e2e/webcard-esc.spec.ts` (phase 1a).

Agent canvas phase 1a (browser only, no server yet): the web card Esc fix (DRAW-14: the card frame keeps focus, a Done button and a hint when the page has taken focus); strict, non-normalising validation of stored elements, settings and file rows in `src/shared/validate.ts`; canonicalisation in `src/shared/canonical.ts`, used only when a `.chalana` file is opened, so opened files are tidied (colours, numbers, options, pressures, ids and references, long texts, strokes split by count and size) and then strictly validated, and the toast says what changed; every SVG export attribute is escaped with `attr()`; source limits (pencil strokes carry on as a new stroke at a size-aware cap of 4,096 points, or 2,918 with pen pressure, so a stroke stays under the 256 KB element cap whatever its coordinates; text resizes keep the font size within 1–1,000; 10,000 characters per text; 200 per frame name; rotations wrapped into [0, 2π)); an idempotent `finalizeScene` that keeps object identity and can be scoped to touched ids (Rule A); move, resize and rotate computed by id against the live scene, plus `rebaseElements` and a lazy `RemoteLog` in `src/scene/rebase.ts` (Rule C building blocks); fractional layer keys with `assignKeys` in `src/shared/keys.ts` (Rule E, not yet stored; malformed stored keys get a fresh key). Evidence: `src/shared/shared.test.ts`, `src/io/svgsafety.test.ts`, `e2e/webcard-esc.spec.ts`.

| Area | P0 feature IDs (done) | P1 feature IDs (done) | P2 feature IDs (done) |
| --- | --- | --- | --- |
| Drawing | DRAW-01, DRAW-02, DRAW-03, DRAW-04, DRAW-07, DRAW-08, DRAW-10, DRAW-17, DRAW-21 | DRAW-05, DRAW-06, DRAW-11, DRAW-12, DRAW-13, DRAW-15, DRAW-20, DRAW-22 | DRAW-09, DRAW-14, DRAW-16, DRAW-18, DRAW-19 |
| Styling | STYLE-01, STYLE-02, STYLE-05, STYLE-11, STYLE-12, STYLE-13 | STYLE-03, STYLE-04, STYLE-06, STYLE-07, STYLE-08, STYLE-09, STYLE-10, STYLE-14 | — |
| Selecting and arranging | ARR-01, ARR-02, ARR-03, ARR-04, ARR-05 | ARR-06, ARR-07, ARR-08, ARR-09, ARR-10, ARR-11, ARR-12, ARR-13, ARR-14 | — |
| Canvas and view | VIEW-01, VIEW-02, VIEW-03, VIEW-12, VIEW-13, VIEW-16 | VIEW-04, VIEW-06, VIEW-07, VIEW-08, VIEW-09, VIEW-10, VIEW-11, VIEW-14, VIEW-15 | VIEW-05 |
| Save, open, and export | FILE-01, FILE-02, FILE-03, FILE-08, FILE-10 | FILE-04, FILE-05, FILE-06, FILE-07 | FILE-09 |

P2 notes: new tools Shape tidy (S), Pour colour (B), Web card (W) and Spotlight (X, also in look-only mode); pencil pressure can be switched off in Settings; Board overview toggles from the zoom strip or Alt+M; pasting rows of numbers opens the chart preview. Web cards embed YouTube, Vimeo, Figma and CodePen in sandboxed frames; other sites show a safe open-in-new-tab link. Spotlight trails are never saved.

P1 notes: pictures are inserted from the main menu ("Insert picture…"), by paste, or by drop; links accept only http(s), mailto and in-board `#el=` targets, and unsafe links are dropped when a file is opened; embedded board data in PNG (`tEXt` chunk) and SVG (`<metadata id="chalanamaya-scene">`) is validated, and damaged data is refused without touching the board; preferences (input preference, pen mode) are kept under `chalanamaya.prefs`.

Review round 2 fixes: style changes made while typing are part of the single text-edit undo step (VIEW-12 with STYLE-11/12/13 and DRAW-10); Ctrl/⌘ + wheel zoom is capped at 1.2× per event (VIEW-02); handle resizing follows the pointer delta (ARR-03); drags are cancelled on window blur and pointer cancel; dialogs return focus to the control that opened them; switching theme autosaves the board settings; an unreadable autosaved board is kept under `chalanamaya.board.unreadable` instead of being overwritten (FILE-01).

P1 review fixes: look-only mode (VIEW-07) now blocks every board-changing action at the shared action layer (undo, redo, clear, paste, lock/unlock all, insert picture, open, duplicate, delete, text edits) and hides or disables those controls in the menu, zoom strip and board settings; locked items (ARR-10) refuse text editing, and double-clicking one offers "Unlock it" for just that item; SVG export (FILE-04) applies the chosen scale to width/height while the viewBox stays in board units; items drawn inside a page frame join it (DRAW-13); the first corner of a new box or frame snaps too, and Alt skips snapping (VIEW-11).

Known limits: images are stored as data URLs inside the single localStorage entry, so a large photo can exceed the browser quota (the storage warning then appears); moving files to IndexedDB is left for a later phase. Right-aligned auto-width text grows leftwards from the click point by design. Connector labels sit on a patch of the board colour, which also hides grid lines behind the label. Cross-hatch fills use the light-theme swatch colour, so they look pale in the dark theme. Live web cards (DRAW-14) are an HTML layer above the board canvas, so they always show on top of drawn items, selection handles and Spotlight trails regardless of layer order; start using a card by double-clicking it or by selecting it and pressing Enter (Esc or Done returns to the board). The board overview (VIEW-05) can be focused with Tab and moved with the arrow keys (Shift for a full view); the properties panel shortens while it is shown so the two never overlap.
