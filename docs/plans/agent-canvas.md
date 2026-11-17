# Plan: board sessions, agent drawing (MCP) and media

Status: **planning round 1, waiting for owner review.** No application code has been written for this plan yet.

Specs added with this plan: [06 — Sessions and agents](../features/06-sessions-and-agents.md) (SESS, AGENT) and [07 — Media](../features/07-media.md) (MEDIA). This plan explains how they are built; the specs say what "done" means.

## 1. Goal in one paragraph

Every board becomes a **board session** with its own address, `/s/<id>`. A small Node server in this repo stores sessions in SQLite, serves the app, keeps every open tab in sync in real time, and offers an **MCP server** so agents (Claude, Devin, ChatGPT, or any MCP client) can read and draw on a session when they know its id. Boards also get three new kinds of moving content: **animated GIFs**, **videos (MP4/WebM)** and **animated CSS components**. Users and agents can add, move, resize, rotate, group, layer, lock, undo and export all of them.

## 2. Where we start (current code)

- Front end only: React 19, strict TypeScript, Vite, Canvas 2D with roughjs and perfect-freehand.
- The scene is an ordered array `readonly SceneElement[]` plus a `FileMap` (`src/scene/types.ts`). Array order is the layer order. Elements are immutable objects; every change makes new objects. This is important: it lets the sync layer find changes by comparing object references.
- `Store` (`src/store/store.ts`) holds `AppState`. `commit()` records a history snapshot; `updateElements()` changes the scene live (drags, typing). `onSceneChange` is the autosave hook. Undo/redo (`src/scene/history.ts`) stores whole snapshots `{elements, files}`.
- `finalizeScene()` (`src/scene/scene.ts`) re-places bound text and connector ends after any change. It is pure code and also works in Node. Text width comes from a canvas when there is a DOM, and from an estimate (`0.55 × font size` per character) when there is not (`src/scene/text.ts`).
- Saving: `src/io/autosave.ts` writes one localStorage key `chalanamaya.board.v1`; `src/io/serialize.ts` has `parseElement` / `parseBoardObject`, a strict validator that already normalises every field. Pictures are data URLs inside `files`.
- Web cards (`src/ui/WebCards.tsx`) are an HTML layer over the canvas, so they always show above drawn items.
- Known bug: Esc does not leave an active web card. `WebCards.tsx` calls `frame.focus()` on the cross-origin iframe when a card becomes active. From then on, key presses go to the iframe's document, so the `keydown` listener in `src/App.tsx` (line ~370) never sees Esc.
- Checks: `npm run lint`, `npm run typecheck`, `npm test` (Vitest, `src/**/*.test.ts`), `npm run build`, `npm run test:e2e` (Playwright, served by `vite preview` on port 5184; helpers in `e2e/helpers.ts` read the board from localStorage).

## 3. Architecture

### 3.1 Parts

```
Browser tab(s) ──WebSocket /api/sessions/:id/socket──┐
                ──REST /api/... (files, create)──────┤
                                                     ▼
                                  Node server (one process)
                          Express 5 app ── SessionService ── SQLite (better-sqlite3)
                                  │                 └────── media files on disk
Agent (HTTP MCP client) ──POST /mcp (Streamable HTTP)┘
Agent (desktop, stdio) ── chalanamaya-mcp (bridge) ──► POST /mcp on the same server
```

- **One server process** owns all sessions. Browser tabs, the HTTP MCP endpoint and the stdio bridge all reach the same `SessionService`, so an agent edit is broadcast to every open tab at once, and `get_scene` always sees what users drew.
- The **stdio entry point does not open the database**. It is a thin MCP proxy: it speaks stdio to the desktop client and forwards every request to the server's `/mcp` endpoint (`CHALANAMAYA_URL`, default `http://127.0.0.1:5180`). Reason: two processes writing the same SQLite file could not broadcast live changes to browsers. One tool implementation, one source of truth.

### 3.2 Libraries (all widely used)

| Need | Library | Notes |
| --- | --- | --- |
| HTTP | `express` 5 | Already a dependency of the MCP SDK. |
| WebSocket | `ws` | Attached to the same HTTP server (`upgrade` event). |
| MCP | `@modelcontextprotocol/sdk` (1.x) | `McpServer`, `StreamableHTTPServerTransport`, `StdioServerTransport`, `Client` for tests and the bridge. |
| Validation | `zod` (v4; the SDK accepts `^3.25 \|\| ^4`) | Used for MCP tool schemas, REST bodies and socket messages. |
| Storage | `better-sqlite3` | Synchronous, transactional, WAL mode. Prebuilt binaries exist for Node 22 on Linux, macOS and Windows. |
| Layer order keys | `fractional-indexing` | String keys between neighbours, so a reorder changes one row, not the whole list. |
| HTML sanitising (components) | `dompurify` | Runs in the browser at render time. |
| GIF frames (fallback) | `gifuct-js` | Only when the browser has no `ImageDecoder`. |
| Dev runner | `tsx` (dev dependency) | `npm run dev` runs the server from TypeScript. |
| Server bundle | Vite SSR build (already installed) | `vite build --ssr` with a separate `vite.server.config.ts`; no new bundler. |

Node `node:sqlite` was considered: it is still experimental on Node 22, so we keep the owner's choice, `better-sqlite3`.

### 3.3 Code layout

```
server/
  main.ts            start-up: read config, open db, listen
  app.ts             createApp(config): Express app + ws + MCP; used by tests too
  config.ts          env: PORT (5180), HOST (127.0.0.1), DATA_DIR (./data), PUBLIC_URL, limits
  db/                schema + migrations (PRAGMA user_version), repositories
  sessions/          SessionService (load, apply ops, changes since rev, snapshot), in-memory cache (LRU)
  sync/socket.ts     WebSocket handler (hello, push, ack, broadcast)
  media/             upload, type sniffing, disk store, Range responses
  mcp/               buildMcpServer(service), tools/, input.ts (agent input -> elements),
                     compact.ts (elements -> agent view), prompts.ts, resources.ts, http.ts
  stdio.ts           the chalanamaya-mcp bridge
  security/          headers (CSP), limits, rate limits, URL rules, id redaction for logs
src/shared/          pure code used by both sides: protocol types, limits, ids, palette names,
                     component presets, URL rules
src/sync/            SyncClient (socket, pending ops, reconcile), session routing, legacy import
src/media/           GIF decoder, video registry, animation loop
src/ui/              SessionMenu, ConnectAgentDialog, MediaDialog, ComponentDialog, LiveLayer
skills/chalanamaya/  SKILL.md (+ reference.md with examples)
docs/agents/         setup.md, mcp-tools.md
docs/security.md
```

Shared code is imported by the server with the same `bundler` module resolution and bundled by the Vite SSR build, so `src/scene/*` and `src/io/serialize.ts` are reused as they are. `tsconfig.json` `include` gains `server` and `skills` is plain markdown. Vitest `include` gains `server/**/*.test.ts`.

### 3.4 Scripts and ports

- `npm run dev` — `tsx watch server/main.ts`; in development the server mounts Vite in middleware mode, so one port (5183) serves the app with hot reload, the API, the socket and `/mcp`.
- `npm run build` — typecheck, `vite build` (app to `dist/`), `vite build --ssr -c vite.server.config.ts` (to `dist-server/main.js` and `dist-server/stdio.js`).
- `npm start` — `node dist-server/main.js` (default port 5180, host 127.0.0.1).
- `npm run mcp:stdio` and the package `bin` `chalanamaya-mcp` → `dist-server/stdio.js`.
- Playwright starts `npm run build && node dist-server/main.js` on port 5184 with `DATA_DIR=test-results/e2e-data` (wiped first). Port 4173 is never used.
- `.gitignore` gains `data/` and `dist-server/`.

### 3.5 Storage (SQLite)

File: `${DATA_DIR}/chalanamaya.db`, WAL mode, `foreign_keys=ON`, migrations by `PRAGMA user_version`.

```sql
sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL,  -- JSON: viewBackgroundColor, gridEnabled
          rev INTEGER NOT NULL DEFAULT 0, element_count INTEGER NOT NULL DEFAULT 0,
          media_bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER)
elements (session_id TEXT REFERENCES sessions ON DELETE CASCADE, id TEXT,
          idx TEXT NOT NULL,        -- fractional layer key
          version INTEGER NOT NULL, -- bumped on every write of this element
          rev INTEGER NOT NULL,     -- session rev of the last write (for catch-up)
          deleted INTEGER NOT NULL DEFAULT 0,  -- tombstone
          needs_layout INTEGER NOT NULL DEFAULT 0,
          data TEXT NOT NULL,       -- the SceneElement JSON (validated by parseElement)
          PRIMARY KEY (session_id, id))
files (session_id TEXT REFERENCES sessions ON DELETE CASCADE, id TEXT, mime TEXT, size INTEGER,
       sha256 TEXT, width INTEGER, height INTEGER, duration_ms INTEGER,
       source TEXT CHECK (source IN ('upload','remote')), url TEXT, created_at INTEGER,
       PRIMARY KEY (session_id, id))
```

- Uploaded bytes are files on disk: `${DATA_DIR}/media/<sha256>` (content-addressed, shared between sessions, deleted when no row points at them). Disk files allow fast `Range` responses for video seeking.
- Theme and viewport stay per browser (they are personal), not in the session.
- Layer order is `ORDER BY idx, id`.

### 3.6 Sync protocol

Model: **the server is the single authority and orders all writes. Each element is last-writer-wins.** The browser applies its own changes at once (optimistic) and then reconciles with what the server confirms.

Messages are JSON, validated with zod on both sides (`src/shared/protocol.ts`).

Client → server:

| Message | Fields | Meaning |
| --- | --- | --- |
| `hello` | `clientId`, `sinceRev?` | First message. `sinceRev` asks for changes after that rev (reconnect). |
| `push` | `pushId`, `ops: Op[]` | A batch of changes (max 500 ops, max 2 MB). |
| `ping` | — | Keep-alive every 25 s. |

`Op` = `{ t: "put", el: SceneElement, idx: string, baseVersion: number }` | `{ t: "del", id, baseVersion }` | `{ t: "settings", settings: { viewBackgroundColor?, gridEnabled?, title? } }`.

Server → client:

| Message | Fields | Meaning |
| --- | --- | --- |
| `snapshot` | `rev`, `elements: {el, idx, version}[]`, `files: FileMeta[]`, `settings`, `title` | Full state, when `sinceRev` is missing or older than the tombstone horizon. |
| `changes` | `fromRev`, `rev`, `ops` (with server versions), `files?`, `origin: {kind: "browser"\|"agent", name}` | Someone else's accepted batch. |
| `ack` | `pushId`, `rev`, `versions: Record<id, number>`, `rejected: {id, reason}[]` | Result of my push. |
| `error` | `code`, `message` | For example `session_not_found`, `too_large`, `rate_limited`. |

Server rules for one `push` (one SQLite transaction):

1. Validate each element with `parseElement` plus the size limits (§7). Invalid ops are rejected one by one; the rest are applied.
2. `put` on a live element: accepted (last writer wins). `version` becomes `stored + 1`.
3. `put` on a **tombstone**: accepted only if `baseVersion` equals the tombstone's version (the client knew it was deleted, for example an undo of a delete). Otherwise rejected with `deleted`, so a late drag cannot bring back something another tab or an agent removed.
4. `del` writes a tombstone. Tombstones are kept 30 days; older ones are purged and clients asking for an older `sinceRev` get a `snapshot`.
5. The session `rev` increases by one per accepted batch. `changes` is broadcast to all other sockets of the session; the sender gets `ack`.

Client side (`src/sync/SyncClient.ts`):

- Keeps `confirmed: Map<id, {el, idx, version}>` (server truth) and `pending: Op[]` (sent, not yet acked, or not yet sent).
- **Finding local changes:** after every `store.set` that changes `elements`, compare each element object with the last one sent (reference equality, cheap because elements are immutable); new or changed objects become `put`, missing ids become `del`. Layer keys: walk the array and give a new `fractional-indexing` key only to elements whose key is not between their neighbours' keys (the same idea as Excalidraw's "sync moved indices"). Sends are batched: at most one push per 50 ms during drags, right away after a commit.
- **Applying remote changes:** update `confirmed`, then the visible scene = `confirmed` with `pending` laid on top, sorted by key. Elements in `pending` keep the local version until acked, so a drag in progress never jumps. Remote changes are applied with a new store method `applyRemote()`, which does not touch history and does not trigger a push.
- **Ack:** drop those ops from `pending`, store server versions. **Rejected ops:** drop them, restore the confirmed element, and show a short notice ("Someone removed that item, so your change was not kept.").
- **Reconnect:** exponential back-off (0.5 s to 10 s). Send `hello` with the last `rev`; resend `pending`. While offline, the status chip says "Offline — your changes will be sent when the connection is back"; unsent ops are also mirrored to `localStorage["chalanamaya.pending.<id>"]` so a reload does not lose them.

**Undo/redo stays personal.** Snapshot undo would otherwise wipe agent edits. When a remote change arrives, `History.rebase(ops)` applies the same change to every stored snapshot (replace the element where it exists, insert added elements at their layer position, remove deleted ones). So undo only reverts this tab's own steps, and agent or other-tab changes are kept. History length stays 200; a unit test checks a 5,000-element board with 200 snapshots rebases in under 50 ms.

**Text measured on the server:** when the server creates or changes text (agent tools), it measures with the estimate and sets `needs_layout = 1`. The first browser that receives such an element (fonts loaded) runs `layoutText`/`finalizeScene`, and sends one correcting `put` marked `layout: true`. This correction is not added to history and clears the flag. Only flagged elements are corrected, so two tabs never fight over sizes.

### 3.7 How the browser and agents share one scene

- Agents never touch raw rows. MCP tools call `SessionService.applyAgentChange(sessionId, mutate)`, where `mutate` receives the current element array and returns a new one using the same pure functions the UI uses (`createShape`, `groupElements`, `reorder`, `alignElements`, `deleteElements`, `finalizeScene`…). The service diffs before/after into ops and runs the same push path as a browser, with `origin = {kind: "agent", name}`. So bindings, bound labels and frames behave exactly as when a person draws.
- `name` is the MCP client's `clientInfo.name` from `initialize`, mapped to a friendly label ("Claude", "Devin", "ChatGPT", otherwise "An agent"). The HTTP transport runs in **stateful** mode (`sessionIdGenerator: randomUUID`, idle transports closed after 30 minutes) so the server remembers the client name. Note: the MCP protocol's own "session" header is unrelated to the board `session_id`; docs say this clearly.
- Agent changes are remote changes, so a user's undo does not revert them (see 3.6). To keep a safety net, an agent `clear_scene` shows a notice in open tabs, "Claude cleared the board · Restore"; Restore pushes the removed items back (a `put` with `baseVersion` equal to each tombstone's version, so rule 3 accepts it) as one local, undoable change.
- In the browser, agent changes get a soft lagoon outline for 1.5 s and, if they are off-screen, a notice "Claude added 6 items · Show" that zooms to them (AGENT-11).

### 3.8 Files in sessions

- `BinaryFile` becomes `{ id, mimeType, dataURL?: string, url?: string, width?, height?, size?, posterFileId? }`. Exactly one of `dataURL` or `url`.
- In a session, inserting a picture (menu, paste, drop) uploads it first (`POST /api/sessions/:id/files`, raw body) and the element points at `url = /api/sessions/:id/files/:fileId`. `insertImageBlob` goes through a small `FileStore` interface: `ServerFileStore` in the app, `MemoryFileStore` (data URLs) in unit tests.
- Saving a `.chalana` file, copying, and embedding scene data in PNG/SVG fetch each `url` file and inline it as a data URL, so files stay portable. Opening a `.chalana` file or importing the old localStorage board uploads its data URLs and swaps them for `url`s.
- `.chalana` `FORMAT_VERSION` becomes 2 (new element types, file `url`). Version 1 files keep opening.

## 4. Session lifecycle and URLs

- **Id:** 18 random bytes from `crypto.randomBytes` / `crypto.getRandomValues`, base64url → 24 characters (144 bits). Format check everywhere: `^[A-Za-z0-9_-]{24}$`. Element ids also move to random 96-bit ids so agents, tabs and the server cannot collide.
- `GET /` serves the app. The app calls `POST /api/sessions` and then `location.replace("/s/<id>")`. The session is created by JavaScript, not by the GET itself, so link previews, crawlers and prefetchers do not create empty boards. (The owner's "opening `/` creates a new session and redirects" is kept; the redirect happens in the page.)
- `GET /s/<id>` serves the app for any well-formed id. The app loads the session over the socket; an unknown id shows "This board does not exist (or was deleted)" with a **Start a new board** button. Bad formats get a 404 page.
- **Main menu → Board session:** shows the title (editable) and a short id; **New board** (opens `/` in this tab; Ctrl/⌘+click for a new tab), **Copy board link**, **Copy session id**, **Connect an agent…** (dialog with the MCP address, the session id and ready-to-paste setup snippets), **Recent boards** (up to 20, kept in `localStorage["chalanamaya.sessions"]`), **Delete this board** (P2, confirm; `DELETE /api/sessions/:id`).
- **Old localStorage board:** if `chalanamaya.board.v1` holds elements and was not imported yet, a banner offers **Import it into this board** (into an empty session, or "add beside the current items" when the session already has content). Files are uploaded first, then elements are pushed in one batch (one undo step). The old key is kept and marked `chalanamaya.board.v1.importedTo = <id>`; the banner also offers **Remove the old copy**. The same import is in the main menu.
- **Clean-up:** sessions that never had an element are deleted after 24 h. Other sessions are kept until deleted; an optional `SESSION_TTL_DAYS` deletes boards not opened for that long (off by default).
- **REST API** (JSON, all ids validated):
  - `POST /api/sessions` `{title?}` → `201 {session_id, url}`
  - `GET /api/sessions/:id` → `{session_id, title, rev, element_count, created_at, updated_at}`
  - `GET /api/sessions/:id/scene` → `{rev, elements, files, settings}` (full, used by tests, import and export)
  - `POST /api/sessions/:id/ops` `{ops}` → same result as a socket `ack` (for tools and tests)
  - `POST /api/sessions/:id/files` (raw body, `Content-Type` = media type) → `{file_id, url, mime, size, width?, height?}`
  - `GET /api/sessions/:id/files/:fileId` → bytes, supports `Range`
  - `DELETE /api/sessions/:id` → `204`
  - `GET /api/health` → `{ok: true, version}`

## 5. MCP server

### 5.1 Endpoints

- **Streamable HTTP:** `POST/GET/DELETE /mcp` on the app server. DNS-rebinding protection on (`allowedHosts` = the configured host names). JSON body limit 16 MB (allows a 10 MB base64 upload).
- **stdio:** `npx chalanamaya-mcp` (or `npm run mcp:stdio`), env `CHALANAMAYA_URL`. It proxies `tools/*`, `prompts/*`, `resources/*` to `/mcp` and passes the desktop client's `clientInfo`.

### 5.2 Conventions for every tool

- Every board tool takes `session_id`. It accepts the bare id or a full board URL (`https://host/s/<id>`); the id is extracted and checked.
- **Coordinates:** board units; x grows to the right, y grows down; `(0, 0)` is the board origin. A new board at 100 % zoom shows about x 0–1280, y 0–800. Shapes, text, notes, frames and media are placed by their **top-left corner** with `width`/`height`. `angle` is in **degrees** clockwise (stored as radians). Points for paths are absolute board coordinates `[x, y]`.
- **Forgiving input:** missing `x`/`y` → the item is placed in free space to the right of existing content (reported back); missing size → sensible defaults (box 160×80, note 180×180, frame 800×600, web card 480×300, media 480 wide keeping its aspect ratio); colours accept palette names or hex; sizes accept names (`"s" | "m" | "l" | "xl"`, `"thin" | "bold" | "extra-bold"`); unknown extra fields are ignored with a warning, not an error.
- **Batches are atomic:** a call either applies all changes in one server rev (one undo-free change for the user, one broadcast) or none.
- **Locked items** (ARR-10) are refused by `update_elements`, `move_elements`, `set_style`, `delete_elements`, `group_elements` and `reorder_elements` with the error `<id> is locked; unlock it first`; `update_elements` with `locked: false` unlocks (and may change the item in the same update). `clear_scene` removes locked items too, like the Clear canvas action.
- **Errors** return `isError: true` with a precise path and a hint, for example: `elements[2].to: no element or key "b9" in this board or this call. Known keys: start, decision.`
- **Output:** every tool returns `structuredContent` (with an `outputSchema`) and the same JSON as text content for clients that only read text.
- **Palette names** (from the approved swatches): stroke `ink #193a36`, `lagoon #007f78`, `clay #b65b24`, `berry #c0392b`, `sky #2f6fb5`, `moss #6b8e23`; fill `none`, `mint #bfe8e2`, `peach #ffd9b8`, `rose #f7c6c1`, `cloud #c9dcf5`, `sage #e3edc2`; notes `butter #ffe59a`, `apricot #ffd2b0`, `seafoam #c9efe6`, `mist #d6e4fb`, `blush #f6d0e2`.

### 5.3 Shared input shapes

```ts
type Ref = string;                 // an element id, or a `key` given earlier in the same call
type Color = PaletteName | `#${string}`;

interface StyleInput {             // all optional
  stroke?: Color; fill?: Color | "none";
  fill_style?: "hachure" | "cross-hatch" | "zigzag" | "solid";
  stroke_width?: "thin" | "bold" | "extra-bold" | number;   // 0.5–32
  stroke_style?: "solid" | "dashed" | "dotted";
  roughness?: "tidy" | "sketchy" | "wobbly";
  edges?: "sharp" | "round";
  opacity?: number;                // 0–100
  font?: "hand" | "normal" | "code";
  font_size?: "s" | "m" | "l" | "xl" | number;               // 8–400
  text_align?: "left" | "center" | "right";
}

interface Common extends StyleInput {
  key?: string;                    // name to refer to this item later in the same call
  x?: number; y?: number; width?: number; height?: number;   // |x|,|y| ≤ 1,000,000; size 1–100,000
  angle?: number;                  // degrees
  locked?: boolean; link?: string; // http(s), mailto or "#el=<id>"
  group?: string;                  // items in this call with the same group name are grouped
  frame?: Ref;                     // put inside this page frame
}

type ElementInput =
  | Common & { type: "rectangle" | "diamond" | "ellipse"; label?: string }
  | Common & { type: "text"; text: string }                       // width given => wraps
  | Common & { type: "note"; text?: string; color?: Color }
  | Common & { type: "frame"; name?: string; contains?: Ref[] }
  | Common & { type: "arrow"; from?: Ref | Point; to?: Ref | Point; points?: Point[];
               label?: string; routing?: "straight" | "curved" | "elbow";
               start_arrowhead?: Arrowhead; end_arrowhead?: Arrowhead }
  | Common & { type: "line"; points: Point[]; closed?: boolean }  // 2–1,000 points
  | Common & { type: "freedraw"; points: Point[] | [number, number, number][] }  // with pressure, ≤ 5,000
  | Common & { type: "image" | "gif"; file_id?: string; url?: string }
  | Common & { type: "video"; file_id?: string; url?: string; autoplay?: boolean; loop?: boolean;
               muted?: boolean; poster_file_id?: string }
  | Common & { type: "web_card"; url: string }
  | Common & { type: "component"; preset?: PresetName; params?: Record<string, string | number>;
               html?: string; css?: string; title?: string };
type Point = [number, number];
```

Connector rules: `from`/`to` with a `Ref` bind the end to that shape, note, frame, image or media item (the existing binding code places the end on the outline and keeps it attached when the shape moves); a `Point` leaves the end free. `points` (optional) adds bend points in between.

### 5.4 Tool list

| Tool | Input (besides `session_id`) | Output |
| --- | --- | --- |
| `create_session` | `title?` (the only tool without `session_id`) | `{session_id, url}` |
| `get_session_info` | — | `{session_id, url, title, rev, element_count, open_tabs, bounds}` |
| `get_scene` | `format?: "json" \| "outline"` (default json), `ids?`, `region?: {x,y,width,height}`, `query?` (text search), `limit?` (≤ 500, default 200), `cursor?` | `{rev, bounds, count, elements: CompactElement[], next_cursor?, free_space: {x, y}}` or `{rev, outline: string}` |
| `add_elements` | `elements: ElementInput[]` (1–200) | `{rev, created: [{key?, id, type, x, y, width, height}], warnings: string[]}` |
| `update_elements` | `updates: ({id} & Partial<ElementInput without type>)[]` (1–200) — text, label, name, url, points, from/to, geometry, style, locked, link | `{rev, updated: string[], warnings}` |
| `move_elements` | `ids`, either `dx`/`dy` or `to: {x, y}` (new top-left of the group's box) | `{rev, moved: string[], bounds}` |
| `set_style` | `ids`, `style: StyleInput` | `{rev, updated: string[], skipped: [{id, reason}]}` (e.g. fill on a text) |
| `delete_elements` | `ids` (labels go with their shape; connectors to deleted items are unbound) | `{rev, deleted: string[]}` |
| `group_elements` / `ungroup_elements` | `ids` | `{rev, group_id?}` |
| `reorder_elements` | `ids`, `to: "front" \| "back" \| "forward" \| "backward"` | `{rev}` |
| `arrange_elements` | `ids` (≥ 2), `align?: "left" \| "center" \| "right" \| "top" \| "middle" \| "bottom"`, `distribute?: "horizontal" \| "vertical"`, `gap?` | `{rev, bounds}` |
| `clear_scene` | `confirm: true` (required) | `{rev, deleted_count}` |
| `upload_media` | `data_base64`, `mime_type`, `filename?` (≤ 10 MB decoded) | `{file_id, mime_type, size, width?, height?, duration_ms?}` |
| `place_media` | `kind: "image" \| "gif" \| "video"`, `source: {file_id} \| {url} \| {data_base64, mime_type}`, `x?`, `y?`, `width?`, `height?`, `autoplay?`, `loop?`, `muted?` | `{rev, id, file_id}` |
| `list_component_presets` | `session_id` optional | `{presets: [{name, description, params: {name, type, default}}]}` |

`CompactElement` (only non-default fields; layer order back to front; bound labels folded into their shape):

```json
{ "id": "k3f…", "type": "rectangle", "x": 100, "y": 80, "w": 160, "h": 80, "label": "Start",
  "stroke": "ink", "fill": "mint", "fill_style": "solid", "group": "g1", "frame": "f1" }
{ "id": "a9…", "type": "arrow", "from": "k3f…", "to": "p0q…", "label": "yes", "points": [[260,120],[400,120]] }
{ "id": "z1…", "type": "freedraw", "x": 0, "y": 0, "w": 90, "h": 40, "point_count": 120 }
{ "id": "m2…", "type": "video", "x": 600, "y": 80, "w": 480, "h": 270, "file_id": "…", "mime": "video/mp4" }
```

The `outline` format is one line per item, for example `box k3f "Start" at (100,80) 160×80 mint` and `connector a9 k3f → p0q "yes"`. Responses are capped at about 50 KB; `next_cursor` continues.

### 5.5 Prompts, resources and the skill

Prompts:
- `draw_diagram` — args `session_id`, `description`, `kind?` (flowchart, mind map, sequence, architecture, timeline, wireframe, freeform). Returns step-by-step instructions: read the board, plan a grid, add items in one or two batches with keys, connect, check with `get_scene`.
- `explain_board` — `session_id`; asks the agent to read the outline and summarise it.
- `tidy_board` — `session_id`; asks the agent to align, distribute and fix overlaps.
- `chalanamaya_guide` — no args; the drawing guide text.

Resources:
- `chalanamaya://guide` — the skill text (same file as `skills/chalanamaya/SKILL.md`, bundled at build time).
- `chalanamaya://reference/elements` — the input shapes above as JSON Schema plus examples.
- `chalanamaya://reference/palette` — colour names and hex values for light and dark boards.
- `chalanamaya://reference/component-presets` — presets and parameters.
- Template `chalanamaya://session/{session_id}/scene` and `…/outline` — read-only views of a board.

Skill (`skills/chalanamaya/SKILL.md`, YAML front matter `name`, `description`, portable to Claude Skills and other agents): what ChalanaMaya is; the coordinate system; a 40-unit layout grid and spacing rules (80 between boxes, 160 between rows); size and font guidance; how to use `key` and `from`/`to`; colour meaning (lagoon = main path, clay = attention, notes for comments); a workflow (get_scene → plan → add in batches → verify → tidy); recipes for flowchart, mind map, timeline, architecture, sequence and wireframe; media and component examples; limits and common errors. `skills/chalanamaya/reference.md` holds copy-ready JSON examples.

## 6. Media element model and rendering

### 6.1 Model

| Content | Element | Notes |
| --- | --- | --- |
| Animated GIF | existing `image` element whose file is `image/gif` | Keeps crop and flip. New optional field `paused?: boolean`. |
| Video | new `VideoElement` `type: "video"`: `fileId`, `autoplay` (true), `loop` (true), `muted` (true), `paused?` | `fileId` points at an uploaded or remote file; poster at `files[fileId].posterFileId`. |
| CSS component | new `ComponentElement` `type: "component"`: `source: {kind: "preset", preset, params} \| {kind: "custom", html, css}`, `title` | Rendered in the HTML live layer. |

Remote media (`url` given instead of an upload) becomes a file entry `{source: "remote", url}`. **The server never fetches remote URLs**, so there is no server-side request forgery. The browser loads them directly. Rules: `https:` only, no user/password, no IP-literal, `localhost` or `.local` hosts, at most 2,048 characters.

All new elements reuse `BaseElement`, so move, resize (keep aspect with Shift for media, like pictures), rotate, select, group, layer order, lock, frames, links, undo/redo and sync work without special cases. `parseElement`, `hit.ts`, `geometry.ts`, `transform.ts`, `svg.ts`, `renderScene.ts`, the properties panel and the compact agent view each get the new types.

### 6.2 Rendering

- **GIF and video are drawn on the board canvas**, so layer order, rotation, opacity, crop, the board overview and Spotlight work like other items.
  - GIF: `ImageDecoder` (WebCodecs) decodes frames on demand (keeps at most 3 `ImageBitmap`s per GIF). Without `ImageDecoder`, `gifuct-js` decodes, limited to 50 million pixels in total (width × height × frames); bigger GIFs show their first frame with a notice. Note: `drawImage()` of an `<img>` GIF only paints the first frame, which is why a decoder is needed.
  - Video: a hidden `<video playsInline muted loop crossOrigin="anonymous">` per element; `drawImage(video)` paints the current frame. At most 6 videos play at once (the rest show their poster with a play badge); videos off-screen pause.
  - An **animation loop** (`requestAnimationFrame`, at most 30 fps for the scene canvas) runs only while a playing GIF or video is visible; it stops when the tab is hidden. `prefers-reduced-motion` starts everything paused.
  - Controls: properties panel buttons Play/Pause, Mute/Unmute, Loop, Restart, plus a play badge on the item itself. No new single-key shortcut (Space keeps its pan meaning). Sound only after a user action (browser autoplay rules).
- **CSS components live in the HTML live layer** (today's `WebCards` layer, renamed `LiveLayer`). Each is an `<iframe sandbox="" srcdoc="…" referrerpolicy="no-referrer">` — **no `allow-scripts`, no `allow-same-origin`**, so it is a unique origin that can run no script, open no popups and submit no forms. `pointer-events: none` always (components are look-only), so the board handles selection and dragging; the canvas draws its frame and handles. Within the live layer, items follow board layer order, but the layer sits above the canvas (the same documented limit as web cards).
- **Component content:**
  - Presets (built-in templates from `src/shared/presets.ts`; parameters are typed and validated, no free text goes into CSS): `pulse` (dot with colour), `spinner` (colour, speed), `typing-dots`, `progress-bar` (value 0–100, colour, label), `shimmer-card` (lines), `marquee` (text, speed), `bounce-arrow` (direction, colour), `gradient-wave` (two palette colours). Text parameters are HTML-escaped.
  - Custom: `html` ≤ 20 KB and `css` ≤ 20 KB. The server checks sizes and rejects obvious bad content with clear messages (`<script`, `on*=` attributes, `javascript:`, `@import`, `url(` other than `data:image/png|jpeg|gif|webp`, `<iframe`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`, `<form>`). At render time the browser runs DOMPurify with an allow-list (layout and text tags, inline `svg` shapes, attributes `class`, `id`, `style`, `aria-*`, `role`; no `href`/`src` except `data:` images) and a CSS filter for the same patterns. The `srcdoc` starts with `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`. Three layers: server check, sanitiser, sandbox without scripts.

### 6.3 Export and file fallbacks

| Item | PNG export / copy as PNG | SVG export | `.chalana` file |
| --- | --- | --- | --- |
| GIF | first frame | `<image href="data:image/gif…">` (browsers animate GIFs inside SVG) | inlined file |
| Video | poster frame + small play badge; placeholder card ("Video · name") if no poster | poster `<image>` + play badge, wrapped in a link to the video when it is remote | inlined file under 50 MB total, otherwise kept as a link with a warning |
| Component | static card: title and "Animated component" (presets draw a simple still picture) | same static card as SVG shapes | the element data (HTML/CSS) |
| Remote media without CORS | placeholder card with the host name (the export canvas must not be tainted) | `<image href>` to the remote URL with a warning | link only |

Posters: when a browser first loads a video that has no poster, it captures a frame at 0.1 s, uploads it as a PNG and sets `posterFileId` (a `layout`-style sync op, not in history). For remote videos without CORS no poster can be captured; the placeholder is used.

## 7. Security limits

- **Access model:** no accounts in this round. The **session id is the access token**: anyone (person or agent) who has it can read and change the board. 144 random bits; never logged in full (logs show the first 4 characters); `Referrer-Policy: strict-origin-when-cross-origin` so other sites see only the origin, never `/s/<id>` (YouTube embeds need at least the origin); the "Connect an agent" dialog and docs say "treat the link like a password". Documented in `docs/security.md` and in SESS-08.
- **Binding:** listens on `127.0.0.1` by default. Exposing it (`HOST=0.0.0.0`, a tunnel for ChatGPT) is an explicit choice, and docs recommend HTTPS in front.
- **Input validation:** zod for every REST body, socket message and MCP input; `parseElement` for every stored element; ids checked by format.
- **Size caps (defaults, configurable):** 5,000 live elements per session; 64 KB per element JSON; 10 MB per session scene JSON; 10,000 characters per text; 5,000 points per pencil path; 500 ops / 2 MB per socket message; 2 MB REST JSON; 16 MB MCP JSON; 200 elements per MCP call; images and GIFs 10 MB, videos 25 MB per file; 200 MB media per session; 50 sockets per session.
- **Media checks:** allowed types `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `video/mp4`, `video/webm`; the first bytes must match the claimed type (magic numbers); no SVG uploads. Served with the sniffed type, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, max-age=31536000, immutable`.
- **No server-side fetching** of remote media (no SSRF). Remote URL rules in §6.1.
- **Rate limits** (`express-rate-limit`, per IP): 30 new sessions per minute, 60 uploads per minute, 600 MCP requests per minute; socket pushes limited to 50 per second per connection.
- **Headers for the app:** CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.figma.com https://codepen.io; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`. (`srcdoc` frames inherit this policy; it allows their inline styles.) WebSocket upgrades must come from the same `Origin`. MCP DNS-rebinding protection on.
- **No secrets in the repo:** config only from environment; `.env` files ignored; tests use temp data folders.
- **Components:** see §6.2 (no script execution, three layers).

## 8. Testing strategy

**Unit (Vitest, Node):**
- ids: length, alphabet, entropy source; session URL parsing (`session_id` as id or URL).
- Agent input → elements: every type, defaults, palette names, degrees → radians, `key`/`from`/`to` resolution, atomic failure, error messages (snapshot of messages).
- Compact view and outline: default fields omitted, labels folded, order, paging, size cap.
- Sync: change detection by reference, fractional key repair, reconcile (pending over confirmed, ack, reject, reconnect resend), tombstone rule, `History.rebase` correctness and the 50 ms performance case.
- Server repositories and `SessionService` with an in-memory SQLite (`:memory:`).
- Media: magic-number sniffing, remote URL rules, GIF pixel budget.
- Components: sanitiser with a corpus of attacks (script tags, `onerror`, `javascript:` URLs, `@import`, external `url()`, `<meta refresh>`, SVG `<foreignObject>` and `<a>`, CSS `expression`); preset parameter validation and escaping.
- Esc fix: controller/App logic for leaving an active card.

**Integration (Vitest, Node, real server on a random port with a temp `DATA_DIR`):**
- REST: create, read, ops, files (upload, Range, wrong type, too big), delete, 404s, size limits, rate limits.
- Sockets: two `ws` clients converge; reconnect with `sinceRev`; old `sinceRev` gets a snapshot; tombstone rejection; message too large.
- MCP over HTTP with the SDK `Client` + `StreamableHTTPClientTransport`: `listTools` matches the documented list (test fails if `docs/agents/mcp-tools.md` misses a tool); every tool's happy path and main errors; prompts and resources list and read; an MCP change reaches a socket client as `changes` with `origin.kind = "agent"`; a socket change is seen by `get_scene`.
- MCP over stdio with `StdioClientTransport` spawning the built `dist-server/stdio.js` against the running server.

**End to end (Playwright, Chromium, built server on port 5184):**
- All existing specs keep running. `e2e/helpers.ts` changes once: `freshBoard` opens `/` (new session each test) and `storedElements` reads `GET /api/sessions/<id>/scene`, polling until the socket is idle. Specs that read localStorage directly (`p1.spec.ts`, `revision.spec.ts`, theme in `smoke.spec.ts`) switch to the same helper; preference checks keep reading `chalanamaya.prefs`.
- New `sessions.spec.ts`: `/` redirects to `/s/<24 chars>`; reload restores the board; New board gives a new id; copy link/id; two pages on one session see each other's edits; legacy localStorage board import; unknown id page.
- New `agent.spec.ts`: the test process connects an MCP SDK client to `http://localhost:5184/mcp`, calls `add_elements` (two boxes, a bound connector, a note) and the items appear on the open page within 2 s without reload (checked through the board API and a screenshot region), with the agent notice; then the user drags a box and `get_scene` reports the new position and the connector still bound.
- New `media.spec.ts`: upload a GIF (two-frame fixture) and a WebM/MP4 fixture (a few KB, made with ffmpeg and committed in `e2e/fixtures/`); move, resize, rotate, layer, group, lock, undo; frames change over time (pixel sampling); PNG export works and shows the poster; agent `place_media` adds a video live.
- New `components.spec.ts`: add a preset and a custom component; the iframe has `sandbox=""`; a custom component with `<script>`, `onerror` and `javascript:` does nothing (a `window.__pwned` probe stays undefined and no console errors from the frame); it moves and resizes like other items.
- Web card Esc (phase 1): activate by double-click → Esc leaves; activate by Enter → Esc leaves; after clicking into the page, the **Done** button leaves.

## 9. Docs updates

- `docs/out-of-scope.md`: board-session sync is in scope; real collaboration stays out (done with this plan).
- `docs/README.md`: index entries for specs 06 and 07, scope paragraph, status table rows per phase.
- `docs/features/05-save-open-export.md` (phase 2): FILE-01 changes meaning: the board is saved on the ChalanaMaya server for the session; the browser keeps only unsent changes, preferences and recent boards. FILE-02 notes format version 2 (phase 4).
- `docs/features/01-drawing-tools.md` (phase 1): DRAW-14 acceptance gains "Esc or Done returns to the board".
- New: `docs/agents/setup.md` (Claude Desktop with stdio and as a custom connector, Claude Code `claude mcp add --transport http chalanamaya http://127.0.0.1:5180/mcp`, Devin MCP settings (HTTP URL or stdio command), ChatGPT developer-mode connector (needs a public HTTPS URL, e.g. a tunnel), Cursor / VS Code / generic), `docs/agents/mcp-tools.md` (every tool with examples), `docs/security.md`, root `README.md` (how to run; it still says "specifications only").
- `skills/chalanamaya/SKILL.md` and `reference.md`.

## 10. Risks

1. **Live-layer layer order.** CSS components (and web cards) sit above the canvas, so a box drawn on top of a component still shows under it. Mitigation: documented; GIF and video avoid this by drawing on the canvas. A later fix is "band canvases" (split the scene into canvas layers between live items).
2. **Undo with remote edits.** Snapshot rebasing touches every stored snapshot. Mitigation: unit tests for correctness and speed; if too slow, switch history to stored change lists.
3. **Text sizes differ** between server estimate and browser fonts. Mitigation: the `needs_layout` correction from one browser; agents get sizes back in `created`.
4. **Last-writer-wins can drop a change** when two people edit the same item at the same moment. Acceptable for board-session sync; documented. Deletes are protected by the tombstone rule.
5. **`better-sqlite3` is a native module.** Prebuilt binaries cover common systems; otherwise it needs build tools. Documented in setup.
6. **Video export and posters** need a browser; remote videos without CORS cannot be exported as frames. Mitigation: placeholders, uploads preferred, docs.
7. **GIF memory.** Large GIFs can use a lot of memory. Mitigation: on-demand decoding and a pixel budget.
8. **Client differences.** ChatGPT and Claude custom connectors need a public HTTPS address; some clients ignore resources or prompts. Mitigation: the same guidance is available as a tool-free skill file, prompts and resources; the stdio bridge covers desktop clients.
9. **Session id leaks** (screenshots, shared history, chat logs given to agents). Mitigation: clear warnings, delete board (P2), real authentication is a future project.
10. **Test churn.** Moving the e2e suite to the server touches every spec through the helpers. Mitigation: done in one phase with all specs green before new features.
11. **Single process.** Sessions are in one process; no horizontal scaling. Documented.

## 11. Implementation phases

Each phase ends with `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and `npm run test:e2e` green, its specs' status updated in `docs/README.md`, and a conventional commit on `main`.

### Phase 1 — Server foundation and the web card Esc fix

Delivers: the Esc fix; the Node server (`server/`), config, SQLite schema and migrations, `SessionService`, the REST API of §4, media upload/download for pictures, security headers, rate limits, `npm run dev`/`build`/`start`; Playwright now runs against the built server. The app itself still saves to localStorage (no behaviour change for users).

Esc fix: stop calling `focus()` on the iframe; focus the card wrapper (`tabIndex=-1`) so the board document keeps keyboard focus and Esc works right after activation; add a **Done** button in the active hint bar (outside the iframe); watch `window` `blur` with `document.activeElement` being the frame to show "Click Done or the board to return" when the user clicked into the page (browsers do not pass key presses out of a cross-origin page); return focus to the board on leave.

Acceptance:
- Double-click a YouTube web card, press Esc: the card is no longer active (`webcard-active` gone) and board shortcuts work again. Same after Enter activation. After clicking inside the page, **Done** returns to the board. New e2e test covers all three.
- `npm start` serves the app at `/` and `/s/<id>` exactly as before; `GET /api/health` returns `{ok: true}`.
- Integration tests: `POST /api/sessions` returns a 24-character id; ops are validated with `parseElement`; oversized bodies get 413; bad ids get 404; uploads check magic bytes and limits; `Range` requests return 206.
- Existing unit and e2e suites pass unchanged except for the Playwright `webServer` command.

### Phase 2 — Board sessions with live sync (SESS-01…08)

Delivers: `/` → new session → `/s/<id>`; WebSocket sync (§3.6) with `SyncClient`, reconcile, layer keys, `History.rebase`, `needs_layout`; pictures uploaded to the server; `.chalana` save/open inlining files; Board session menu (New board, Copy link, Copy session id, Recent boards, title); connection status chip and offline queue; legacy localStorage import; FILE-01 spec rewritten; e2e helpers read the server.

Acceptance:
- Opening `/` lands on `/s/<24 chars>`; reload restores elements, pictures and board colour/grid; theme and viewport stay per browser.
- Two pages on the same session: a box drawn in one appears in the other within 1 s; a delete in one removes it in the other; undo in one does not undo the other's work.
- Going offline (Playwright `context.setOffline`) shows the offline chip; edits made offline arrive after reconnect.
- A browser with an old `chalanamaya.board.v1` board sees the import banner; import brings in elements and pictures as one undo step; the old copy stays until removed.
- All existing e2e specs pass on the server-backed app.

### Phase 3 — MCP server, skill and setup docs (AGENT-01…11, AGENT-13)

Delivers: `/mcp` (stateful Streamable HTTP), the stdio bridge, all tools of §5.4 except media-specific ones beyond pictures and web cards (`upload_media`/`place_media` accept images in this phase), prompts, resources, `skills/chalanamaya/`, `docs/agents/setup.md`, `docs/agents/mcp-tools.md`, `docs/security.md`, the Connect an agent dialog, agent highlight and notice.

Acceptance:
- SDK client integration tests pass for every tool, prompt and resource over HTTP, and for a smoke set over stdio.
- `listTools` equals the documented list; each input schema has descriptions; invalid inputs return `isError` with the field path.
- E2E `agent.spec.ts`: an MCP `add_elements` call (boxes, bound connector, note, frame) shows live in the open page within 2 s with the "added items · Show" notice; a user drag is visible in `get_scene` and the connector stays bound.
- An agent following only `SKILL.md` can draw a 6-step flowchart with labelled, bound connectors in one `add_elements` call (covered by an integration test that uses the skill's own flowchart example verbatim).

### Phase 4 — GIF and video elements (MEDIA-01…04, MEDIA-07, MEDIA-09, MEDIA-08 for files)

Delivers: animated GIF playback on canvas, `video` element, upload from file and from link in the UI (Insert media dialog, drop, paste of files), playback controls, animation loop and reduced motion, posters, export fallbacks, `.chalana` version 2, MCP `upload_media`/`place_media`/`add_elements` for `gif` and `video`.

Acceptance:
- A dropped GIF animates on the board (pixel sampling changes over time), can be paused, cropped and flipped.
- A dropped MP4 or WebM plays muted and looped; Play/Pause/Mute/Loop/Restart work from the properties panel; with `prefers-reduced-motion` GIFs and videos start paused.
- GIF and video move, resize, rotate, group, lock, change layer order (a box above a video hides part of it), undo/redo and sync to a second tab.
- PNG export shows the GIF's first frame and the video's poster with a play badge; SVG export embeds the GIF; a `.chalana` save reopens with media.
- Oversized, wrong-type and SVG uploads are refused with a clear message; remote URLs with private hosts are refused.
- An agent `place_media` with a video file appears live in the browser (e2e).

### Phase 5 — Animated CSS components (MEDIA-05, MEDIA-06, MEDIA-08 for components)

Delivers: `component` element, presets, custom HTML/CSS dialog with live preview and limits, sanitiser, sandboxed `srcdoc` rendering in `LiveLayer`, static fallbacks for export, MCP support (`add_elements` type `component`, `list_component_presets`, resource).

Acceptance:
- Each preset can be added from the UI and by an agent, with parameters; it animates and moves/resizes/rotates/groups/locks/undoes like other items.
- Every component iframe has `sandbox=""` (checked in e2e); the attack corpus does not execute script, load remote resources or navigate (e2e probe and unit corpus).
- Custom HTML/CSS over 20 KB, or with forbidden content, is refused with a message naming the rule; the UI dialog shows the same rule.
- PNG/SVG exports show the static card; `.chalana` round trip keeps components.
- `prefers-reduced-motion` pauses component animations (`animation-play-state: paused` injected).

### Phase 6 — Hardening, extras and docs completion (SESS-09, AGENT-12)

Delivers: delete board; empty-session clean-up and optional TTL; MCP resource subscriptions (scene change notifications); performance checks (5,000 elements: load < 2 s, remote batch of 200 applied < 100 ms); a board preview for agents (`get_preview` returns a PNG made by rasterising the existing SVG export with `@resvg/resvg-js`, fonts from bundled files — cut if fonts cannot be made to match); final pass on all docs and the root README.

Acceptance:
- Deleting a board removes its rows and unreferenced media; its URL then shows the "does not exist" page; open tabs get `session_not_found`.
- Empty sessions older than 24 h are removed by a timer (integration test with a fake clock).
- Performance tests pass in CI time limits.
- `get_preview` (if kept) returns a PNG an MCP client can show; otherwise AGENT-12 is marked deferred.
- Docs index, status table and setup guides match the shipped behaviour.

## 12. Open questions for the owner

1. Should agents get an "undo my last change" tool (server keeps per-agent change history), or is delete/update enough?
2. Do you want an opt-in server-side fetch of remote media (with private-address blocking and redirects re-checked) so agents can give a URL and the file is kept on the server? This plan does not fetch, to avoid SSRF.
3. Default retention: keep boards forever (current plan) or delete boards not opened for N days?
4. Should look-only mode (VIEW-07) also exist as a separate read-only session link? That needs a second token per session and is not in this plan.
5. Is the 25 MB video / 200 MB per-session media limit right for your use?
6. Is the live-layer limit (components and web cards always above drawn items) acceptable for now, or should "band canvases" be in phase 5?
