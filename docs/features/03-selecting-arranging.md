# Selecting and arranging

Status: all features are planned. Priorities follow the [tracking guide](../README.md#feature-tracking).

## ARR-01 — Selection methods

**Priority: P0**

Select with a click or box, and add or remove items with Shift.

Acceptance criteria:
- Click selects one unlocked element; a box selects fully enclosed unlocked elements.
- Shift toggles items without clearing the other selected items.
- Lasso uses the same selection rules when DRAW-22 is available.

## ARR-02 — Select all

**Priority: P0**

Select all eligible elements on the board.

Acceptance criteria:
- Select all includes off-screen unlocked elements.
- An empty board produces an empty selection.

## ARR-03 — Move, resize, rotate

**Priority: P0**

Change the position, size, or angle of selected elements.

Acceptance criteria:
- Dragging moves selection; handles resize and rotate it.
- Multi-selection transforms preserve the relative arrangement.
- Locked elements do not move.

## ARR-04 — Duplicate and delete

**Priority: P0**

Make a nearby copy or remove selected elements.

Acceptance criteria:
- Duplicate creates independent copies of selected elements.
- Delete removes editable selection and can be undone.

## ARR-05 — Cut, copy, paste

**Priority: P0**

Transfer selected elements using the clipboard.

Acceptance criteria:
- Copy and paste preserve content, styles, and relationships within the copied set.
- Cut removes elements only after copying succeeds.
- Unavailable clipboard access shows a useful message and does not cut.

## ARR-06 — Group and ungroup

**Priority: P1**

Treat several elements as a unit without merging them.

Acceptance criteria:
- A group can be moved or selected together.
- Ungroup restores independent selection without changing appearance.

## ARR-07 — Z-order

**Priority: P1**

Control which elements appear in front.

Acceptance criteria:
- Bring to front, send to back, move forward, and move backward are available.
- Reordering keeps the relative order of a multi-selection.

## ARR-08 — Align and distribute

**Priority: P1**

Line up elements or space them evenly.

Acceptance criteria:
- Users can align left, centre, right, top, middle, or bottom.
- Three or more elements can have equal horizontal or vertical gaps.

## ARR-09 — Flip

**Priority: P1**

Mirror selected artwork horizontally or vertically.

Acceptance criteria:
- Both horizontal and vertical flips are available.
- Flipping twice on the same axis restores the original geometry.

## ARR-10 — Lock and unlock

**Priority: P1**

Protect elements from accidental edits, including a lock-all action.

Acceptance criteria:
- Locked elements cannot be moved, edited, or erased during normal drawing.
- Users can unlock an individual item or all items through an explicit command.
- Lock all protects every existing element.

## ARR-11 — Switch shape type

**Priority: P1**

Change a basic shape without recreating it.

Acceptance criteria:
- Rectangle, diamond, and ellipse can be switched while keeping text and styles.
- The shape centre and connector bindings are kept.

## ARR-12 — Element links

**Priority: P1**

Attach a URL or a link to another board element.

Acceptance criteria:
- Users can add, edit, remove, and deliberately open a link.
- Internal links navigate to the target; missing targets show a message.
- Unsafe URL schemes are rejected and selecting does not automatically open links.

## ARR-13 — Object and midpoint snapping

**Priority: P1**

Use nearby objects and their midpoints as placement guides.

Acceptance criteria:
- Moving or drawing shows guides and snaps to nearby edges, centres, and midpoints.
- Users can temporarily bypass snapping for free placement.

## ARR-14 — Edit line and arrow points

**Priority: P1**

Adjust a path without drawing it again.

Acceptance criteria:
- Users can move, add, and remove interior points.
- Endpoint editing allows rebinding or detaching arrows.
- Invalid point removal leaves a usable path or is refused clearly.
