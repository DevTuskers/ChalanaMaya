# Canvas and view

Status: all features are planned. Priorities follow the [tracking guide](../README.md#feature-tracking).

## VIEW-01 — Infinite canvas

**Priority: P0**

Work beyond the initial screen in any direction.

Acceptance criteria:
- Panning reveals more drawable space without fixed page edges.
- Returning to previous areas preserves element positions.

## VIEW-02 — Zoom and pan

**Priority: P0**

Change viewing scale and move the viewport.

Acceptance criteria:
- Zoom works around the pointer or viewport centre through visible controls.
- Pan does not change artwork coordinates; zoom has safe minimum and maximum limits.

## VIEW-03 — Zoom to fit

**Priority: P0**

Bring all artwork or the selection into view.

Acceptance criteria:
- Fit all includes every visible artwork element with a margin.
- Fit selection frames selected elements; no selection or empty artwork is handled without an error.

## VIEW-04 — Grid

**Priority: P1**

Show or hide a background grid for drawing guidance.

Acceptance criteria:
- The grid can be toggled without changing artwork.
- Grid lines are view aids, not saved drawing elements.

## VIEW-05 — Minimap

**Priority: P2**

See an overview and jump to another board area.

Acceptance criteria:
- The overview shows artwork and the current viewport.
- Clicking or dragging in it changes the main view; an empty board is handled.

## VIEW-06 — Zen mode

**Priority: P1**

Hide extra controls for a quieter workspace.

Acceptance criteria:
- Zen mode hides nonessential panels without deleting content.
- A clear action or shortcut restores the controls.

## VIEW-07 — Read-only view mode

**Priority: P1**

Explore a board without changing it.

Acceptance criteria:
- Users can pan, zoom, and follow links, but cannot edit or delete.
- Leaving view mode restores editing; this is not a security permission system.

## VIEW-08 — Light and dark themes

**Priority: P1**

Choose a comfortable interface and canvas theme.

Acceptance criteria:
- Both themes keep controls and artwork readable.
- Switching theme does not overwrite explicit element colours.

## VIEW-09 — Canvas background colour

**Priority: P1**

Choose the board's background colour.

Acceptance criteria:
- The background changes without creating an element.
- The chosen colour is saved and used in exports when background is enabled.

## VIEW-10 — Search text

**Priority: P1**

Find words in text elements, notes, and labels.

Acceptance criteria:
- Search highlights matches and lets users move between them.
- Empty queries and no matches show a clear neutral state.

## VIEW-11 — Stats panel

**Priority: P1**

Inspect exact position and size of an element.

Acceptance criteria:
- The panel shows numeric X, Y, width, and height in board units.
- Values update after movement or resizing; no selection shows no stale values.

## VIEW-12 — Undo and redo

**Priority: P0**

Step backward or forward through editing actions.

Acceptance criteria:
- Creation, deletion, movement, styling, and text edits can be undone and redone.
- A new edit after undo clears the redo branch.
- Empty history does not change the board.

## VIEW-13 — Keyboard shortcuts and help

**Priority: P0**

Use common actions from the keyboard and discover them in a help dialog.

Acceptance criteria:
- Help lists the implemented shortcuts with platform-appropriate keys.
- Undo, redo, selection, delete, and zoom have documented shortcuts.
- Typing in text or an input does not trigger unrelated drawing shortcuts; help can be closed by keyboard.

## VIEW-14 — Pen mode

**Priority: P1**

Draw only with a stylus while ignoring touch drawing input.

Acceptance criteria:
- With pen mode on, stylus input draws and touch does not create strokes.
- Users can turn it off without needing a stylus.

## VIEW-15 — Input preference

**Priority: P1**

Choose mouse or trackpad behaviour for navigation.

Acceptance criteria:
- Both preferences explain how scrolling, panning, and zooming work.
- The choice persists locally and does not change artwork.

## VIEW-16 — Toolbar hints

**Priority: P0**

Explain tools with short labels and helpful hints.

Acceptance criteria:
- Hover or keyboard focus reveals a tool name and its shortcut when available.
- The active tool and disabled controls are clear without relying only on colour.
