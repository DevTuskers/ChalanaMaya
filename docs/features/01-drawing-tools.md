# Drawing tools

Status: all features are planned. Priorities follow the [tracking guide](../README.md#feature-tracking).

## DRAW-01 — Rectangle

**Priority: P0**

Draw rectangular boxes for diagrams.

Acceptance criteria:
- Dragging creates a rectangle; its size can be changed.

## DRAW-02 — Diamond

**Priority: P0**

Draw diamond shapes for decisions and other ideas.

Acceptance criteria:
- Dragging creates a diamond that can be resized.

## DRAW-03 — Ellipse

**Priority: P0**

Draw ovals and circles.

Acceptance criteria:
- Dragging creates an ellipse; a modifier keeps it circular.

## DRAW-04 — Arrows and binding

**Priority: P0**

Connect ideas with arrows that can attach to shapes.

Acceptance criteria:
- Straight arrows can be drawn between two points.
- An attached endpoint follows its shape when moved; users can detach it.

## DRAW-05 — Curved and elbow arrows

**Priority: P1**

Choose curved or right-angle connectors instead of straight arrows.

Acceptance criteria:
- Users can choose straight, curved, or elbow routing.
- Moving bound shapes keeps endpoints attached for every route.

## DRAW-06 — Arrow labels

**Priority: P1**

Put editable text on an arrow.

Acceptance criteria:
- A label stays with its arrow when moved or reshaped.
- Editing a label does not detach endpoints.

## DRAW-07 — Lines and polygons

**Priority: P0**

Draw a single line or a path with several points. Closing a path makes a polygon.

Acceptance criteria:
- Users can finish an open polyline or close it at its starting point.
- A closed path can receive a fill.

## DRAW-08 — Freehand pencil

**Priority: P0**

Draw a continuous stroke by hand.

Acceptance criteria:
- Pointer movement creates a stroke until released.
- The stroke remains selectable and editable as an element.

## DRAW-09 — Pencil pressure

**Priority: P2**

Optionally vary pencil width with stylus pressure.

Acceptance criteria:
- Pressure can be turned on or off.
- Devices without pressure input use a steady width.

## DRAW-10 — Text

**Priority: P0**

Place text anywhere or inside a shape. Text grows or wraps to remain readable.

Acceptance criteria:
- Users can create and edit standalone and shape-bound text.
- Unconstrained text grows; width-constrained text wraps.
- Bound text follows its shape; arrow text follows DRAW-06.

## DRAW-11 — Images

**Priority: P1**

Insert pictures and crop the visible area without stretching them.

Acceptance criteria:
- Users can insert an image and resize it with its proportions kept.
- Crop can be adjusted or reset without losing the original image.
- Unsupported images show a clear error without replacing the board.

## DRAW-12 — Sticky notes

**Priority: P1**

Add coloured notes with editable text.

Acceptance criteria:
- Users can create, edit, move, and resize a note.
- Text wraps within the note.

## DRAW-13 — Frames

**Priority: P1**

Use named containers to organise the board like slides.

Acceptance criteria:
- Users can name a frame and put elements inside it.
- Moving a frame moves its contents; removing the frame can keep its contents.

## DRAW-14 — Web embeds

**Priority: P2**

Place YouTube, Figma, or website content in a web card.

Acceptance criteria:
- Supported links display interactive content when the provider allows it.
- Blocked, invalid, or unavailable content shows a safe link or clear message.
- Embedded content cannot silently change board elements.

## DRAW-15 — Eraser

**Priority: P1**

Remove drawn elements with an eraser gesture.

Acceptance criteria:
- Crossed editable elements are removed when the gesture finishes.
- Locked elements are left alone and erasing can be undone.

## DRAW-16 — Laser pointer

**Priority: P2**

Point at an area with a temporary fading trail.

Acceptance criteria:
- The trail fades without becoming saved artwork.
- Using the pointer does not change existing elements.

## DRAW-17 — Hand / pan tool

**Priority: P0**

Move around the board without moving artwork.

Acceptance criteria:
- Dragging with the hand tool pans the view.
- Artwork positions remain unchanged.

## DRAW-18 — Draw-to-shape

**Priority: P2**

Turn a rough outline into a clean basic shape.

Acceptance criteria:
- Recognisable rectangles, diamonds, and ellipses can become editable shapes.
- An unrecognised sketch stays a sketch; conversion can be undone.

## DRAW-19 — Bucket fill

**Priority: P2**

Apply the current fill to a closed shape.

Acceptance criteria:
- Clicking a closed editable shape changes its fill.
- Clicking empty space or an open path does not change other elements.

## DRAW-20 — Tool lock

**Priority: P1**

Keep the chosen drawing tool active for repeated use.

Acceptance criteria:
- With lock on, finishing an element keeps that tool active.
- With lock off, finishing returns to selection.

## DRAW-21 — Selection tools

**Priority: P0**

Use a pick tool to select objects before changing them.

Acceptance criteria:
- Clicking or dragging a selection box selects eligible elements.
- Selected elements have visible handles; empty clicks clear selection.

## DRAW-22 — Lasso tool

**Priority: P1**

Select objects inside a freehand loop.

Acceptance criteria:
- Closing a loop selects unlocked elements fully inside it.
- An empty loop leaves no selection and changes no artwork.
