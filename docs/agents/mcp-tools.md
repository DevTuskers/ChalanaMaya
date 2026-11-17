# ChalanaMaya MCP tools

The built-in MCP server (`POST /mcp`, or the stdio bridge `dist-server/stdio.js`; see the [setup guide](setup.md)) gives agents these tools, prompts and resources. Code: `server/mcp/` (`tools.ts`, `elements.ts`, `view.ts`, `guide.ts`, `http.ts`) and `server/stdio.ts`.

## Conventions

- Every tool except `create_session` takes `session_id`: the 24-character board id or the whole board link (`https://…/s/<id>`).
- Every write tool takes an optional `agent_name` (for example `"Claude"`), shown in the board's notices; without it the notice says "An agent". The stdio bridge fills it with the desktop client's name.
- Each call is **atomic**: it changes the board completely or not at all, and goes through the same scene rules as the app (bound labels, connector bindings, frames, layer keys), so the change shows live in every open tab.
- Coordinates are board units: `x` grows right, `y` grows down, boxes by their top-left corner, angles in degrees clockwise. Path points (`line`, `arrow`, `freedraw`) are absolute `[x, y]` (freedraw `[x, y, pressure]`).
- Inputs are forgiving: numbers as strings, palette names or hex colours (`"lagoon"`, `"#2f6fb5"`), named sizes (`"m"`, `"bold"`), unknown fields are ignored with a warning.
- Results come as `structuredContent` and the same JSON as text. Errors have `isError: true` and `{"error": {"code", "message"}}` with the path of the bad input, for example `elements[3].to: no element or key "b9". Known keys: start, check`.

## Tools

| Tool | Input | Result |
| --- | --- | --- |
| `create_session` | `title?` | `{session_id, url}` |
| `get_session_info` | — | `{session_id, url, title, rev, element_count, open_tabs, bounds, background, grid}` |
| `update_session` | `title?`, `background?` (board colour name or hex), `grid?` | `{rev, title, background, grid}` |
| `get_scene` | `format?: "json" \| "outline"`, `detail?: "compact" \| "full"`, `ids?`, `region?: {x, y, width, height}`, `query?`, `limit?` (≤ 500, default 200), `cursor?` | `{rev, bounds, count, elements, next_cursor?, free_space}` or `{rev, outline, next_cursor?}` |
| `add_elements` | `elements` (1–200 items; see below) | `{rev, created: [{key?, id, type, x, y, width, height}], warnings}` |
| `update_elements` | `updates: [{id, …fields}]` (1–200) | `{rev, updated, warnings}` |
| `move_elements` | `ids`, `dx`/`dy` or `to: {x, y}` | `{rev, moved, bounds}` |
| `set_style` | `ids`, `style` | `{rev, updated, skipped: [{id, reason}]}` |
| `delete_elements` | `ids` | `{rev, deleted}` (labels go with their shape; connectors are unbound) |
| `group_elements` / `ungroup_elements` | `ids` | `{rev, group_id?}` |
| `reorder_elements` | `ids`, `to: "front" \| "back" \| "forward" \| "backward"` | `{rev}` |
| `arrange_elements` | `ids` (≥ 2), `align?`, `distribute?: "horizontal" \| "vertical"`, `gap?` | `{rev, bounds}` |
| `clear_scene` | `confirm: true` | `{rev, deleted_count}`; open tabs get "… cleared the board · Restore" |
| `upload_media` | `data_base64`, `mime_type`, `filename?` (PNG, JPEG, GIF, WebP ≤ 10 MB decoded; MP4, WebM ≤ 25 MB) | `{file_id, mime_type, size, width, height, duration_ms}` (video size and duration read from the file header; `null` when unknown) |
| `place_media` | `kind?: "image" \| "gif" \| "video"`, `source: {file_id} \| {data_base64, mime_type} \| {url, mime_type?}`, `x?`, `y?`, `width?`, `height?`, `autoplay?`, `loop?` (videos) | `{rev, id, file_id, warnings}`; a `url` is an https link the browser shows live (never fetched by the server; a placeholder card in exports), and the result warns that uploading gives full support |
| `list_component_presets` | — | `{presets: []}` (animated components arrive later) |

### Element input (`add_elements`)

Types: `rectangle`, `ellipse`, `diamond`, `text`, `note`, `frame`, `arrow`, `line`, `freedraw`, `image`, `gif`, `video`, `web_card`. Common fields: `key`, `x`, `y`, `width`, `height`, `angle`, `locked`, `link`, `group`, `frame`, and style (`stroke`, `fill`, `fill_style`, `stroke_width`, `stroke_style`, `roughness`, `edges`, `opacity`, `font`, `font_size`, `text_align`). Per type: `label` (boxes and arrows), `text` (text, note), `color` (note), `name` and `contains` (frame), `from`/`to` (id, key or `[x, y]`), `points`, `routing`, `start_arrowhead`/`end_arrowhead` (arrow), `points` and `closed` (line), `file_id` or `url` (image, gif, video), `paused` (image, gif, video), `autoplay`, `loop` (video), `url` (web card). Items without `x`/`y` go into free space to the right of the board. The full reference is the `chalanamaya://reference/elements` resource.

### Reading: compact and full

`get_scene` returns compact items by default (rounded geometry, colours as names, connectors as `from`/`to`), capped at about 50 KB per page; follow `next_cursor` for more. A cursor is pinned to the board revision and the filters: if the board changed in between, the call fails with `stale_cursor` (start again without a cursor).

`detail: "full"` (with `ids`, at most 50, `format: "json"`) returns every field `update_elements` accepts, including absolute path points with pressures, bend points, bindings, arrowheads and crop. Passing a full item back to `update_elements` unchanged leaves the board unchanged, so agents can edit a single point and write it back.

## Errors

| Code | When |
| --- | --- |
| `invalid_session_id` | not a board id or link |
| `session_not_found` | no such board |
| `invalid_input` | a bad field; the message has its path and a hint |
| `locked` | `<id> is locked; unlock it first` (`update_elements` with `locked: false` unlocks) |
| `stale_cursor` | the board changed since the cursor was made |
| `too_large` / `storage_full` | over a size limit or the server is full |
| `invalid_input` on a link | a `url` that is not https, has a user name or password, or names an IP address, `localhost`, a single-word host or a private name (`.local`, `.internal`, `.lan`, `.home.arpa`, …); or a `kind` that does not match the file (`kind: "video"` with a picture) |
| `kind_not_supported_yet` | a `component` item: animated components arrive in a later version |

## Prompts and resources

Prompts: `draw_diagram` (`session_id`, `description`, `kind?`), `explain_board` (`session_id`), `tidy_board` (`session_id`), `chalanamaya_guide`.

Resources: `chalanamaya://guide` (the skill, Markdown), `chalanamaya://reference/elements`, `chalanamaya://reference/palette`, `chalanamaya://reference/component-presets`, and the templates `chalanamaya://session/{session_id}/scene` and `chalanamaya://session/{session_id}/outline`. Boards are never listed: the templates have no list, and an agent must be given the id.

## Limits

16 MB per MCP request (and per stdio message), 200 items per call, 5,000 items per board, 10 MB per picture, coordinates within ±1,000,000, sizes 1–100,000, 1,000 points per line or arrow, 5,000 per freedraw stroke, 10,000 characters per text. `/mcp` is rate-limited per address (`RATE_LIMIT_MCP`, 600 per minute).
