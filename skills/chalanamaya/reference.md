# ChalanaMaya tool examples

Copy-ready arguments for the ChalanaMaya MCP tools. Replace `SESSION` with the board's session
id or URL.

## A small flowchart

```json
{
  "session_id": "SESSION",
  "agent_name": "Claude",
  "elements": [
    { "type": "ellipse", "key": "start", "x": 120, "y": 40, "width": 160, "height": 80, "label": "Start", "fill": "mint", "fill_style": "solid" },
    { "type": "rectangle", "key": "read", "x": 120, "y": 200, "label": "Read input" },
    { "type": "diamond", "key": "ok", "x": 100, "y": 360, "width": 200, "height": 100, "label": "Valid?", "stroke": "clay" },
    { "type": "rectangle", "key": "save", "x": 120, "y": 540, "label": "Save" },
    { "type": "rectangle", "key": "err", "x": 400, "y": 370, "label": "Show error", "fill": "rose", "fill_style": "solid" },
    { "type": "arrow", "from": "start", "to": "read" },
    { "type": "arrow", "from": "read", "to": "ok" },
    { "type": "arrow", "from": "ok", "to": "save", "label": "yes", "stroke": "lagoon" },
    { "type": "arrow", "from": "ok", "to": "err", "label": "no" }
  ]
}
```

## A frame with contents

```json
{
  "session_id": "SESSION",
  "elements": [
    { "type": "frame", "key": "web", "x": 0, "y": 0, "width": 480, "height": 240, "name": "Web tier" },
    { "type": "rectangle", "key": "ui", "x": 40, "y": 80, "label": "UI", "frame": "web" },
    { "type": "rectangle", "key": "api", "x": 280, "y": 80, "label": "API", "frame": "web" },
    { "type": "arrow", "from": "ui", "to": "api" }
  ]
}
```

## Notes, text, lines and freehand

```json
{
  "session_id": "SESSION",
  "elements": [
    { "type": "note", "x": 640, "y": 40, "text": "Ask about retries", "color": "butter" },
    { "type": "text", "x": 640, "y": 260, "width": 240, "text": "Long text wraps at the width you give.", "font": "normal", "font_size": "s" },
    { "type": "line", "points": [[640, 360], [880, 360], [760, 440]], "closed": true, "fill": "peach" },
    { "type": "freedraw", "points": [[640, 500, 0.4], [660, 520, 0.6], [690, 515, 0.7], [720, 540, 0.5]] }
  ]
}
```

## Read one item in full, change it, write it back

```json
{ "session_id": "SESSION", "detail": "full", "ids": ["ARROW_ID"] }
```

Take `elements[0]` from the result, change for example `points` (absolute) or `routing`, and
send it as `{"session_id": "SESSION", "updates": [ELEMENT]}` to `update_elements`.

## Pictures

```json
{ "session_id": "SESSION", "kind": "image", "source": { "data_base64": "iVBORw0KGgo…", "mime_type": "image/png" }, "x": 900, "y": 80, "width": 240 }
```

GIFs and videos use the same tool with `"kind": "gif"` or `"kind": "video"`; a link is
`{"source": {"url": "https://media.example.com/clip.mp4"}}` (shown live, a placeholder in exports):

```json
{ "session_id": "SESSION", "kind": "video", "source": { "file_id": "FILE" }, "x": 80, "y": 400, "width": 480, "loop": true }
```

## Animated components

A preset (see `list_component_presets` for each preset's `params`) and a custom one, with `add_elements`:

```json
{ "session_id": "SESSION", "elements": [
  { "type": "component", "preset": "progress-bar", "params": { "value": 70, "color": "#007f78" }, "title": "Upload", "x": 80, "y": 600 },
  { "type": "component", "title": "Badge", "html": "<div class=\"b\">New</div>", "css": ".b{animation:p 1s infinite}@keyframes p{50%{opacity:.4}}", "x": 420, "y": 600, "width": 200, "height": 120 }
] }
```

No scripts, event attributes, outside `url()` or `@import`; HTML and CSS up to 20 KB each.

## Tidy

```json
{ "session_id": "SESSION", "ids": ["A", "B", "C"], "align": "middle", "distribute": "horizontal", "gap": 80 }
```
