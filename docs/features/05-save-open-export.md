# Save, open, and export

Status: all features are planned. Priorities follow the [tracking guide](../README.md#feature-tracking).

## FILE-01 — Autosave

**Priority: P0**

Save the board as it changes and restore it on return.

Since agent-canvas phase 2 a board is a session saved on the ChalanaMaya server ([SESS-05](06-sessions-and-agents.md#sess-05--boards-saved-on-the-chalanamaya-server)); browser storage only keeps changes not yet acknowledged by the server, preferences, recent boards and the board of the earlier browser-only version until it is imported or removed ([SESS-06](06-sessions-and-agents.md#sess-06--import-a-board-saved-in-this-browser)).

Acceptance criteria:
- After an edit, the board and images are saved and restored on reload.
- Storage failure shows a warning and leaves the current board usable.
- Explain that changes not yet saved to the server are kept only in this browser, and recommend file backups.

## FILE-02 — Save and open .chalana

**Priority: P0**

Use ChalanaMaya's own JSON-based .chalana file for portable editable boards.

Acceptance criteria:
- Saved files include a format version, elements, images, and board settings.
- Opening a valid file restores editable content after confirming replacement of an existing board.
- Invalid or unsupported files show an error and leave the current board unchanged.

## FILE-03 — PNG export

**Priority: P0**

Export the board or selection as a PNG image.

Acceptance criteria:
- PNG export includes the requested content with no editor controls.
- Users can turn the background on or off and choose an output scale.
- Empty content or export failure gives a clear message without losing the board.

## FILE-04 — SVG export

**Priority: P1**

Export the board or selection as an SVG image.

Acceptance criteria:
- SVG output preserves supported shapes and text appearance.
- Users can turn the background on or off and choose an output scale.
- Unsupported live embeds get a clear placeholder or warning rather than silently disappearing.

## FILE-05 — Dark-mode export

**Priority: P1**

Choose dark or light rendering for PNG and SVG exports.

Acceptance criteria:
- An export setting controls dark or light output independently of the current interface.
- The choice respects the background toggle and does not edit the scene.

## FILE-06 — Embedded scene data

**Priority: P1**

Optionally include editable scene data inside PNG or SVG exports.

Acceptance criteria:
- Turning the option on allows the exported file to reopen as an editable board, including images.
- Turning it off leaves no reopenable scene payload.
- Users are warned that embedded data may contain content beyond what the image shows; damaged data gives an error without replacing the board.

## FILE-07 — Copy as PNG, SVG, or text

**Priority: P1**

Copy an image or text representation without saving a file.

Acceptance criteria:
- Users can copy the selection or board as PNG, SVG markup, or plain text from text-bearing elements.
- Empty text content gives a clear message.
- Clipboard rejection explains the failure and offers file export where suitable.

## FILE-08 — Paste images and text

**Priority: P0**

Bring clipboard images or plain text onto the board.

Acceptance criteria:
- An image becomes an image element; plain text becomes editable text near the current view.
- Unavailable, empty, or unsupported clipboard content gives feedback without changing existing content.

## FILE-09 — Spreadsheet charts

**Priority: P2**

Paste spreadsheet rows as a bar, line, or radar chart.

Acceptance criteria:
- A preview lets users choose bar, line, or radar and identify labels and numeric values.
- Valid data creates a chart on the board; empty or invalid data explains what needs fixing.
- Cancel leaves the board unchanged.

## FILE-10 — Clear canvas

**Priority: P0**

Remove the current board's artwork after confirmation.

Acceptance criteria:
- Confirmation explains that all elements, including locked ones, will be removed.
- Cancel preserves the board; confirmed clearing can be undone during the session.
- Autosave records the cleared state after confirmation.
