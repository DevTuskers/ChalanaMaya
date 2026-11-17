---
name: chalanamaya
description: Draw diagrams, flowcharts, mind maps, timelines, wireframes and notes on a ChalanaMaya whiteboard through its MCP tools. Use when the user gives you a ChalanaMaya board (a session id or a /s/<id> URL) and asks you to draw, place, explain or tidy things on it.
---

# Drawing on a ChalanaMaya board

ChalanaMaya is a hand-drawn style whiteboard. Every board is a **session**: its URL ends in
`/s/<session_id>` (24 characters). The person keeps the board open in a browser and sees your
changes appear live. All you need is the session id (or the whole URL); every tool except
`create_session` takes it as `session_id`.

Pass `agent_name` (for example `"Claude"`) on every write so people see who changed the board.

## Coordinates

- Board units. x grows to the right, y grows **down**. `(0, 0)` is the board origin.
- A new board at 100 % zoom shows about x 0–1280, y 0–800.
- Boxes, text, notes, frames and pictures are placed by their **top-left corner** with `width`
  and `height`. `angle` is in degrees, clockwise.
- Path points (`points`, `from`, `to` as `[x, y]`) are **absolute** board coordinates.
- Leave out `x`/`y` and the item goes in free space to the right of the content. `get_scene`
  returns `free_space`, a good top-left for a new group of items.

## Layout rules that look good

- Work on a 40-unit grid. Default box 160×80; note 180×180; frame 800×600.
- 80 units between boxes in a row, 160 between rows. Keep a flow going one way (left → right or
  top → bottom).
- Font sizes: `s` 16, `m` 20 (default), `l` 28 for headings, `xl` 40 for a title.
- Short labels (1–4 words) inside boxes; longer explanations in a `note` or free `text` with
  a `width` so it wraps.

## Colours

Stroke: `ink` (default), `lagoon`, `clay`, `berry`, `sky`, `moss`.
Fill: `none`, `mint`, `peach`, `rose`, `cloud`, `sage`. Notes: `butter`, `apricot`, `seafoam`,
`mist`, `blush`. Any `#hex` works too.

Meaning that reads well: lagoon/mint for the main path, clay/peach for attention or decisions,
berry/rose for errors or risks, notes for comments. Use `fill_style: "solid"` for calm, filled
boxes; the default `hachure` looks sketchy.

## Workflow

1. **Read** the board: `get_scene` (use `format: "outline"` on busy boards, or filter with
   `region`, `query` or `ids`).
2. **Plan** a grid on paper first: rows, columns, the coordinates of each box.
3. **Add** items in one or two `add_elements` batches. Give every item a `key` and connect with
   arrows using `from`/`to` keys in the same call. Each call is atomic: all or nothing.
4. **Verify** with `get_scene`; fix with `update_elements`, `move_elements`, `set_style`.
5. **Tidy** with `arrange_elements` (align, distribute with a `gap`).

## Keys and connectors

```json
{"session_id": "…", "agent_name": "Claude", "elements": [
  {"type": "rectangle", "key": "a", "x": 80, "y": 80, "label": "Start", "fill": "mint", "fill_style": "solid"},
  {"type": "rectangle", "key": "b", "x": 320, "y": 80, "label": "Done"},
  {"type": "arrow", "from": "a", "to": "b", "label": "go"}
]}
```

`from`/`to` with an id or key attach the end to that box's outline; it stays attached when the
box moves. `[x, y]` leaves the end free. `points` adds bend points in between.
`routing: "elbow"` draws right-angle connectors, `"curved"` draws a curve.

## Example: a 6-step flowchart in one call

Six nodes in one column (rows 160 apart), a decision with labelled `yes`/`no` branches, and
every arrow bound to its boxes. Copy it, change the labels and the `session_id`, and send it as
one `add_elements` call.

<!-- flowchart-example:start -->

```json
{
  "session_id": "<session_id>",
  "agent_name": "Claude",
  "elements": [
    { "type": "ellipse", "key": "start", "x": 400, "y": 40, "width": 200, "height": 80, "label": "Order placed", "fill": "mint", "fill_style": "solid" },
    { "type": "rectangle", "key": "check", "x": 400, "y": 200, "width": 200, "height": 80, "label": "Check stock" },
    { "type": "diamond", "key": "instock", "x": 400, "y": 360, "width": 200, "height": 100, "label": "In stock?", "stroke": "clay", "fill": "peach", "fill_style": "solid" },
    { "type": "rectangle", "key": "ship", "x": 400, "y": 540, "width": 200, "height": 80, "label": "Ship order" },
    { "type": "rectangle", "key": "reorder", "x": 720, "y": 370, "width": 200, "height": 80, "label": "Reorder stock", "stroke": "berry", "fill": "rose", "fill_style": "solid" },
    { "type": "ellipse", "key": "done", "x": 400, "y": 700, "width": 200, "height": 80, "label": "Done", "fill": "mint", "fill_style": "solid" },
    { "type": "arrow", "from": "start", "to": "check" },
    { "type": "arrow", "from": "check", "to": "instock" },
    { "type": "arrow", "from": "instock", "to": "ship", "label": "yes" },
    { "type": "arrow", "from": "instock", "to": "reorder", "label": "no" },
    { "type": "arrow", "from": "reorder", "to": "check", "routing": "elbow" },
    { "type": "arrow", "from": "ship", "to": "done" }
  ]
}
```

<!-- flowchart-example:end -->

## Editing precisely

- `get_scene` with `detail: "full"` and `ids` (≤ 50) returns every field, with absolute points.
  Change what you need and send the objects back to `update_elements` as they are.
- For `update_elements`, `points` is the **whole** path; `from`/`to` set or clear attachments.
- Locked items are refused; send `locked: false` in `update_elements` first if the user wants it.
- `delete_elements` takes labels along and unbinds connectors. `clear_scene` needs
  `confirm: true` and the person gets a Restore button.

## Recipes

- **Flowchart:** start/end as `ellipse`, steps as `rectangle`, decisions as `diamond`
  (200×100), one column top → bottom, 160 between rows; `yes`/`no` arrow labels.
- **Mind map:** central `ellipse` (xl label), branches as rectangles on a circle of radius
  ~320, leaves as notes; arrows with `end_arrowhead: "none"`.
- **Timeline:** a long `line` at y = 400, small `ellipse` markers on it, `text` dates above and
  notes below, 200 apart.
- **Architecture:** one `frame` per tier (`contains` the boxes), boxes inside on the grid,
  arrows between tiers; databases as `ellipse` with `fill: "cloud"`.
- **Sequence:** actors as rectangles in a row 240 apart, dashed vertical `line`s down from each,
  horizontal arrows between the lines with labels, 80 apart.
- **Wireframe:** a `frame` as the screen (e.g. 375×812), rectangles with `roughness: "tidy"` for
  controls, `text` for copy, `stroke_style: "dashed"` for placeholders.

## Pictures

Upload pictures with `upload_media` (`data_base64`, `mime_type`; PNG, JPEG, GIF or WebP up to
10 MB) and place them with `place_media` `{source: {file_id}}`, or in one step with
`{source: {data_base64, mime_type}}`. Uploaded pictures render, export and work with every
tool. In this version links to pictures on other sites (`{url}`) are refused with
`links_not_supported_yet`, and `kind: "gif"`/`"video"` and animated components with
`kind_not_supported_yet`: download the picture and upload it instead. Web cards
(`type: "web_card"`, `url`) show a web page.

## Limits and common errors

- Up to 200 items per call, 1,000 points per line, 5,000 per freehand stroke, text up to 10,000
  characters, coordinates within ±1,000,000.
- Errors come back with `isError` and a path, e.g. `elements[2].to: no element or key "b9"…`.
  Fix that item and resend the whole call (nothing was stored).
- `stale_cursor`: the board changed while you paged; call `get_scene` again without a cursor.
- `session_not_found`: check the id after `/s/` in the URL.
- The session id is the only key to a board: anyone with it can read and change the board.
