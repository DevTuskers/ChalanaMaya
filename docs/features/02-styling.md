# Styling

Status: all features are planned. Priorities follow the [tracking guide](../README.md#feature-tracking).

## STYLE-01 — Stroke colour

**Priority: P0**

Choose the outline colour for new or selected elements.

Acceptance criteria:
- A chosen colour applies to editable strokes.
- New elements use the chosen stroke colour.

## STYLE-02 — Background / fill colour

**Priority: P0**

Choose a shape's inside colour or leave it transparent.

Acceptance criteria:
- Closed shapes accept a fill colour or no fill.
- Changing fill does not change the stroke.

## STYLE-03 — Eyedropper

**Priority: P1**

Pick a colour from visible canvas content.

Acceptance criteria:
- Sampling applies the visible colour to the chosen stroke or fill setting.
- Cancel leaves the current setting unchanged.

## STYLE-04 — Fill patterns

**Priority: P1**

Give closed shapes hachure, cross-hatch, zigzag, or solid fills.

Acceptance criteria:
- All four patterns are available and visibly distinct.
- Changing a pattern keeps the chosen fill colour.

## STYLE-05 — Stroke width

**Priority: P0**

Choose thin, bold, or extra bold strokes.

Acceptance criteria:
- All three widths are available for new and selected elements.
- Increasing width does not change element geometry.

## STYLE-06 — Stroke style

**Priority: P1**

Choose solid, dashed, or dotted outlines.

Acceptance criteria:
- All three styles work on shapes, lines, and arrows.
- The chosen width and colour are kept.

## STYLE-07 — Sloppiness

**Priority: P1**

Choose one of three levels of hand-drawn roughness.

Acceptance criteria:
- Three distinct levels are available.
- Changing roughness keeps position and editable shape type.

## STYLE-08 — Edge shape

**Priority: P1**

Choose sharp or round corners where supported.

Acceptance criteria:
- Eligible shapes and elbow paths offer sharp and round edges.
- Unsupported elements do not show a misleading control.

## STYLE-09 — Opacity

**Priority: P1**

Make an element more or less transparent.

Acceptance criteria:
- Opacity ranges from fully transparent to fully opaque.
- Changing opacity affects the whole element without removing it.

## STYLE-10 — Arrowheads

**Priority: P1**

Choose independent markers for both ends of a connector.

Acceptance criteria:
- Choices include none, arrow, bar, circle, triangle, and diamond.
- Filled and outline variants are available for arrow, circle, triangle, and diamond.
- Crow's foot / ER markers support zero, one, many, zero-or-one, zero-or-many, and one-or-many relationships.
- Markers follow the endpoint direction when the arrow changes.

## STYLE-11 — Font family

**Priority: P0**

Choose hand-drawn, normal, or code text.

Acceptance criteria:
- All three families are available for new and selected text.
- Font changes preserve the text content.

## STYLE-12 — Font size

**Priority: P0**

Choose from four named text sizes.

Acceptance criteria:
- Small, medium, large, and extra large are available.
- Changing size updates text bounds and wrapping.

## STYLE-13 — Text alignment

**Priority: P0**

Align text left, centre, or right.

Acceptance criteria:
- Each alignment works for a text box or bound text.
- Changing alignment keeps the text content.

## STYLE-14 — Copy and paste styles

**Priority: P1**

Reuse an element's appearance without copying its content.

Acceptance criteria:
- Users can copy a style and apply it to other elements.
- Only supported style properties transfer; geometry and text stay unchanged.
- Pasting with no copied style changes nothing.
