# Plan: board sessions, agent drawing (MCP) and media

Status: **planning round 2, waiting for owner review.** No application code has been written for this plan yet. Round 2 answers the review of round 1; the [review answers](#13-review-answers-round-2) at the end map each finding to the section that fixes it.

Specs added with this plan: [06 — Sessions and agents](../features/06-sessions-and-agents.md) (SESS, AGENT) and [07 — Media](../features/07-media.md) (MEDIA). This plan explains how they are built; the specs say what "done" means.

## 1. Goal in one paragraph

Every board becomes a **board session** with its own address, `/s/<id>`. A small Node server in this repo stores sessions in SQLite, serves the app, keeps every open tab in sync in real time, and offers an **MCP server** so agents (Claude, Devin, ChatGPT, or any MCP client) can read and draw on a session when they know its id. Boards also get three new kinds of moving content: **animated GIFs**, **videos (MP4/WebM)** and **animated CSS components**. Users and agents can add, move, resize, rotate, group, layer, lock, undo and export all of them.

## 2. Where we start (current code)

- Front end only: React 19, strict TypeScript, Vite, Canvas 2D with roughjs and perfect-freehand.
- The scene is an ordered array `readonly SceneElement[]` plus a `FileMap` (`src/scene/types.ts`). Array order is the layer order. Elements are immutable objects; every change makes new objects.
- `Store` (`src/store/store.ts`) holds `AppState`. `commit()` records a history snapshot and runs `finalizeScene` on the **whole** scene; `updateElements()` does the same without history (drags, typing); `set()` replaces state as given. `onSceneChange` is the autosave hook. Undo/redo (`src/scene/history.ts`) stores whole snapshots `{elements, files}` and `undo()`/`redo()` restore both `elements` and `files`.
- `finalizeScene()` (`src/scene/scene.ts:276`) = `updateBindings(syncBoundTexts(elements))`.
  - `syncBoundTexts` (line 23) already keeps the same object when a label's box did not change, but it measures text (`src/scene/text.ts`: a canvas when there is a DOM, else `0.55 × font size` per character), so two browsers with different font state can compute different label sizes and container heights.
  - `updateBindings` (lines ~127–168) returns a **new object for every bound connector on every call** through `fromAbsolutePoints` (`src/scene/geometry.ts:112`), even when nothing moved.
- The controller (`src/tools/controller.ts`) keeps snapshots during interactions: `move`/`resize`/`rotate` keep `base` (the whole array at drag start) and recompute the whole array from it each frame (`store.updateElements(moveElements(it.base, …))`, ~line 917); every interaction keeps `before: Snapshot`; text editing keeps `textSession.before` (~line 749). `cancel()` (~line 1237) and the restores at ~577, ~785, ~1046 and ~1060 do `store.set({elements: it.before.elements})`; `commitFrom(before)` records that snapshot in history.
- Saving: `src/io/autosave.ts` writes one localStorage key `chalanamaya.board.v1`; `src/io/serialize.ts` has `parseElement` / `parseBoardObject`, a strict validator that normalises every field; `FORMAT_VERSION = 1`. Pictures are data URLs inside `files`.
- One `<canvas>` (`src/ui/Canvas.tsx`) draws the scene and then the overlay (selection, handles) with `renderOverlay`. Web cards (`src/ui/WebCards.tsx`) are an HTML layer above that canvas. The eyedropper (`Canvas.tsx` ~line 131) calls `ctx.getImageData` on the scene canvas.
- Known bug: Esc does not leave an active web card. `WebCards.tsx` (lines 32–39) calls `frame.focus()` on the cross-origin iframe when a card becomes active. From then on key presses go to the iframe's document, so the `keydown` listener in `src/App.tsx` (~line 484) never sees Esc.
- Old app origins: `npm run dev` serves `http://localhost:5183`, `vite preview` serves `http://localhost:5184` (`vite.config.ts`). Old boards live in localStorage **of that origin**.
- Checks: `npm run lint`, `npm run typecheck`, `npm test` (Vitest, `src/**/*.test.ts`), `npm run build`, `npm run test:e2e` (Playwright, 42 tests, served by `vite preview` on port 5184; helpers in `e2e/helpers.ts` read the board from localStorage).

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
Agent (desktop, stdio) ── dist-server/stdio.js (bridge) ──► POST /mcp on the same server
```

- **One server process** owns all sessions. Browser tabs, the HTTP MCP endpoint and the stdio bridge all reach the same `SessionService`, so an agent edit is broadcast to every open tab at once, and `get_scene` always sees what users drew.
- The **stdio entry point does not open the database**. It is a thin MCP proxy: it speaks stdio to the desktop client and forwards every request to the server's `/mcp` endpoint (`CHALANAMAYA_URL`, default `http://localhost:5183`). Reason: two processes writing the same SQLite file could not broadcast live changes to browsers. One tool implementation, one source of truth.

### 3.2 Libraries (all widely used)

| Need | Library and version | Notes |
| --- | --- | --- |
| HTTP | `express` 5 | Already a dependency of the MCP SDK. |
| WebSocket | `ws` 8 | `noServer: true`; our `upgrade` handler only claims socket paths (§3.4). |
| MCP | `@modelcontextprotocol/sdk` `^1.32.2` (checked: 1.32.2 is current) | `McpServer`, `StreamableHTTPServerTransport`, `StdioServerTransport`, `Client` for tests and the bridge, `hostHeaderValidation` middleware. |
| Validation | `zod` 4 | REST bodies, socket messages, MCP schemas (see §5.2 for how strict). |
| Storage | `better-sqlite3` **pinned to `12.11.1`** | Reviewer verified on this VM (Node v22.12.0, x86_64, glibc 2.35): 13.0.0 and 13.2.0 install but crash (`SIGSEGV`, exit 139) on `new Database(':memory:')`; 12.11.1 works (SQLite 3.53.2, WAL ok). Exact pin, plus a smoke test (§3.5). |
| Layer order keys | `fractional-indexing` | String keys between neighbours, so a reorder changes one row. |
| Server text measuring | `fontkit` | Reads the bundled `@fontsource` `.woff` files, so server sizes match the browser (§3.8). |
| HTML sanitising (components) | `dompurify` | Runs in the browser at render time. |
| GIF frames (fallback) | `gifuct-js` | Only when the browser has no `ImageDecoder`. |
| Rate limits | `express-rate-limit` | Limits are configurable and can be turned off in tests (§7). |
| Dev runner | `tsx` (dev dependency) | `npm run dev` runs the server from TypeScript. |
| Server bundle | Vite SSR build (already installed) | `vite build --ssr -c vite.server.config.ts`; no new bundler. |

Node `node:sqlite` was considered: it is still experimental on Node 22, so we keep the owner's choice, `better-sqlite3`.

### 3.3 Code layout

```
server/
  main.ts            start-up: read config, open db (with smoke check), listen
  app.ts             createApp(config): Express app + ws + MCP; used by tests too
  config.ts          env: PORT (5183), HOST, PUBLIC_URL, DATA_DIR (./data), limits, RATE_LIMITS
  db/                schema + migrations (PRAGMA user_version), repositories, smoke.ts
  sessions/          SessionService (load, apply ops, changes since rev, snapshot), LRU cache, quotas
  sync/socket.ts     WebSocket handler (hello, push, ack, broadcast)
  media/             upload, type sniffing, disk store, Range responses
  mcp/               buildMcpServer(service), tools/, input.ts (agent input -> elements),
                     compact.ts (elements -> agent view), prompts.ts, resources.ts, http.ts
  text/measure.ts    fontkit measuring for server-side layout
  stdio.ts           the stdio bridge (bundled with a `#!/usr/bin/env node` banner)
  security/          headers (CSP), host check, limits, rate limits, URL rules, id redaction
src/shared/          pure code used by both sides: protocol types, limits, ids, palette names,
                     component presets, URL rules, rebase helpers
src/sync/            SyncClient, SnapshotRegistry, session routing, legacy import, ServerFileStore
src/media/           GIF decoder, video registry, animation loop and frame budget
src/ui/              SessionMenu, ConnectAgentDialog, MediaDialog, ComponentDialog, LiveLayer,
                     TopOverlay (selection frame above the live layer)
skills/chalanamaya/  SKILL.md (+ reference.md with examples)
docs/agents/         setup.md, mcp-tools.md
docs/security.md
```

- **Two tsconfigs.** `tsconfig.json` stays for the app and e2e. New `tsconfig.server.json` covers `server/`, `src/shared/` and the shared scene/io modules the server imports, with `lib: ["ES2023"]` (no DOM) and `types: ["node"]`, so any DOM use in shared code fails typecheck. `npm run typecheck` runs both. Phase 1 moves the canvas-based default measurer out of `src/scene/text.ts` into `src/ui/measure.ts` (installed with the existing `setMeasure` at app start); `text.ts` keeps only the estimate and the hook, so it compiles without DOM.
- **Vitest projects:** `app` (`src/**/*.test.ts`, environment node, as today) and `server` (`server/**/*.test.ts`, `pool: "forks"` because it loads native `better-sqlite3`).

### 3.4 Scripts, ports and origins

- `npm run dev` — `tsx watch server/main.ts`; the server mounts Vite in middleware mode on **port 5183**, so one origin (`http://localhost:5183`, the same origin as the old `npm run dev`) serves the app with hot reload, the API, the socket and `/mcp`. Vite HMR uses `server.hmr = { server: httpServer, path: "/__vite_hmr" }`; our `upgrade` handler accepts only `^/api/sessions/[A-Za-z0-9_-]{24}/socket$` and leaves every other upgrade to Vite. In dev the CSP adds what React refresh needs (`'unsafe-inline'` for scripts and `ws:` in `connect-src`); production keeps the strict CSP (§7).
- `npm run build` — typecheck (both configs), `vite build` (app to `dist/`), `vite build --ssr -c vite.server.config.ts` (to `dist-server/main.js` and `dist-server/stdio.js`, the latter with a shebang).
- `npm start` — `node dist-server/main.js`. **Defaults: port 5183, listening on loopback only (127.0.0.1 and ::1), printed URL `http://localhost:5183`.** Keeping `localhost:5183` keeps the old dev origin, so a board saved by the old `npm run dev` is visible for import (SESS-06). Someone who used the old `vite preview` origin starts once with `PORT=5184 npm start` and opens `http://localhost:5184` to import; the import banner and `docs/agents/setup.md` say this. (`127.0.0.1` is a different origin from `localhost`; we always print and document `localhost`.)
- `npm run mcp:stdio` → `node dist-server/stdio.js`. The package stays `private` and unpublished, so `npx chalanamaya-mcp` would not resolve. Setup snippets use `node /absolute/path/to/ChalanaMaya/dist-server/stdio.js`; `npm link` (optional) adds a `chalanamaya-mcp` command from the `bin` field.
- `npm run db:smoke` — opens a temporary database, runs `select sqlite_version()`, a WAL write and a read, and exits 0. It runs in `npm test` (server project) and is also the first thing `main.ts` does at start-up (clear error and exit 1 on failure).
- Playwright runs `npm run build && node dist-server/main.js` on **port 5184** with `DATA_DIR=test-results/e2e-data` (wiped first) and `RATE_LIMITS=off`. Port 4173 is never used. Integration tests use random ports in 5000–5999.
- `.gitignore` gains `data/` and `dist-server/`.

### 3.5 Storage (SQLite)

File: `${DATA_DIR}/chalanamaya.db`, WAL mode, `foreign_keys=ON`, migrations by `PRAGMA user_version`.

```sql
sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL,  -- JSON: viewBackgroundColor, gridEnabled
          rev INTEGER NOT NULL DEFAULT 0, element_count INTEGER NOT NULL DEFAULT 0,
          media_bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER,
          opened_at INTEGER)
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
       source TEXT CHECK (source IN ('upload','remote')), url TEXT, poster_file_id TEXT,
       created_at INTEGER, PRIMARY KEY (session_id, id))
blobs (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, refs INTEGER NOT NULL)
```

- Uploaded bytes are files on disk: `${DATA_DIR}/media/<sha256>` (content-addressed, shared between sessions, deleted when `refs` drops to 0). `blobs` makes the global media total (`SUM(size)`) cheap to check. Disk files allow fast `Range` responses for video seeking.
- Theme, viewport and video mute stay per browser (they are personal), not in the session.
- Layer order is `ORDER BY idx, id`.
- **Smoke check** (`server/db/smoke.ts`) at start-up and in CI, see §3.4. Risk 5 explains why.

### 3.6 Sync protocol

Model: **the server is the single authority and orders all writes. Each element is last-writer-wins.** The browser applies its own changes at once (optimistic) and then reconciles with what the server confirms.

Messages are JSON, validated with zod on both sides (`src/shared/protocol.ts`).

`Op` (shared by socket, REST and the server's agent path):

```ts
type Op =
  | { t: "put"; el: SceneElement; idx: string; baseVersion: number; layout?: true }
  | { t: "del"; id: string; baseVersion: number }
  | { t: "settings"; settings: { viewBackgroundColor?: string; gridEnabled?: boolean; title?: string } }
  | { t: "poster"; fileId: string; posterFileId: string };
```

- `layout: true` marks a **layout correction** (§3.8): it may only change derived fields (a text's `x`, `y`, `width`, `height`; a container's `height`) of an element whose `needs_layout` flag is set. The server checks that and clears the flag; the browser does not add the correction to its undo history. If several tabs correct the same element at once, the first one accepted clears the flag and later ones are acknowledged as no-ops (`ignored: "layout_done"`); either result is harmless.
- `poster` sets a file's poster once (§6.4); a second poster for the same file is a no-op.

Client → server:

| Message | Fields | Meaning |
| --- | --- | --- |
| `hello` | `clientId`, `sinceRev?` | First message. `sinceRev` asks for changes after that rev (reconnect). |
| `push` | `pushId`, `ops: Op[]` | A batch of changes (max 500 ops, max 2 MB). |
| `ping` | — | Keep-alive every 25 s. |

Server → client:

| Message | Fields | Meaning |
| --- | --- | --- |
| `snapshot` | `rev`, `elements: {el, idx, version, needsLayout}[]`, `files: FileMeta[]`, `settings`, `title` | Full state, when `sinceRev` is missing or older than the tombstone horizon. |
| `changes` | `fromRev`, `rev`, `ops` (with server `version`s and `needsLayout`), `files?`, `origin: {kind: "browser" \| "agent", name}` | Someone else's accepted batch. Never sent back to the socket that pushed it. |
| `ack` | `pushId`, `rev`, `versions: Record<id, number>`, `rejected: {id, reason}[]`, `ignored: {id, reason}[]` | Result of my push. |
| `error` | `code`, `message` | For example `session_not_found`, `too_large`, `rate_limited`, `storage_full`. |

`SessionService.apply(sessionId, ops, {origin, atomic})` runs in one SQLite transaction:

1. Validate each element with `parseElement` plus the size limits (§7), check that `image`/`video` `fileId`s (and `posterFileId`s) exist in **this session's** `files` table (`unknown_file`), and check the session and global quotas.
2. `put` on a live element: accepted (last writer wins). `version` becomes `stored + 1`.
3. `put` on a **tombstone**: accepted only if `baseVersion` equals the tombstone's version (the client knew it was deleted, for example an undo of a delete). Otherwise rejected with `deleted`, so a late drag cannot bring back something another tab or an agent removed.
4. `del` writes a tombstone. Tombstones are kept 30 days; older ones are purged and clients asking for an older `sinceRev` get a `snapshot`.
5. **Modes.** `atomic: false` (browser pushes): invalid ops are rejected one by one and the rest are applied, so one bad element never blocks a user's other edits. `atomic: true` (every MCP tool call, REST `POST /ops?atomic=1`, legacy import): any rejection rolls the whole transaction back and the caller gets every reason at once.
6. The session `rev` increases by one per accepted batch. `changes` is broadcast to all other sockets of the session; the sender gets `ack`.

### 3.7 Browser side: local changes, remote changes, undo and interactions

This section is the core of sync. It has four rules that together make sure (a) the browser never sends changes it did not make, (b) remote changes are never lost by a drag, cancel or undo, and (c) two tabs reach the same scene and then go quiet.

**Rule A — `finalizeScene` keeps identity and is scoped (fixes the echo loop).**

- `updateBindings` returns the **same object** when the recomputed absolute points, `x`, `y`, `width`, `height` and `angle` are equal to the old ones (compare with `Math.abs(a - b) < 1e-6`), and keeps returning the same array when no element changed. `syncBoundTexts` already compares `x/y/width/height/angle`; it also must keep the container object when the needed height is not larger. Unit test: `finalizeScene(finalizeScene(s))` returns the same array object as `finalizeScene(s)`, for a scene with straight, curved and elbow connectors bound at both ends, connector labels and boxes with labels.
- `finalizeScene(elements, touched?)` gains an optional `touched: ReadonlySet<id>`. With it, only bound texts whose own id or container id is touched, and connectors whose own id or a bound end is touched (or removed), are recomputed. `Store.commit` and `Store.updateElements` pass `touched` = ids whose object differs from the current state, plus removed ids. Without `touched` (opening a file, import, tests) everything is recomputed as today. So a local action can only change the items it touched and their direct dependents.

**Rule B — local and remote changes take different paths (no pushes caused by remote changes).**

- `Store.set()` / `commit()` / `updateElements()` / `undo()` / `redo()` are **local**. After each, the store computes a `LocalChange { put: Set<id>, del: Set<id> }` by comparing the previous and the new element arrays by reference. Because of Rule A and Rule C this diff contains only what this tab's action changed. `SyncClient` adds these ids to its **dirty sets**.
- `Store.applyRemote(ops)` is **remote**. It builds the visible scene from `confirmed` with `pending` laid on top, sorted by layer key, and does **not** run `finalizeScene`, does not touch history, and does not report a `LocalChange`. Remote elements arrive already finalised by the tab or agent that made them (the server runs `finalizeScene` for agent changes, §3.9).
- The only outgoing op that a remote change can cause is a **layout correction** for elements that arrive with `needsLayout` (§3.8). It is sent once per element version, and the server clears the flag, so it cannot loop.
- **Flush:** at most one push per 50 ms during drags, at once after a commit. For each dirty id: if it is in the current scene → `put` (current element, its key, `baseVersion` = confirmed version or 0); if it is in the `del` set and not in the scene → `del`. **An id that is simply missing from the array never becomes a `del`.**
- **Removal guard (defence in depth):** if a local change removes an id that this tab received or saw changed remotely after the snapshot the change was based on, the change is treated as stale: the element is put back, no `del` is sent, and a development warning is logged. Tests assert the guard never fires in normal flows (it exists to catch a code path that forgot Rule C).
- **Ack:** drop those ops from `pending`, store server versions. **Rejected ops:** drop them, restore the confirmed element, and show a short notice ("Someone removed that item, so your change was not kept.").

**Rule C — everything that holds an old snapshot is rebased (fixes data loss during interactions).**

- New `SnapshotRegistry` (`src/sync/rebase.ts`): anything that keeps an elements array for later registers a holder. `applyRemote(ops)` calls `rebaseElements(array, ops, keyOf)` for every holder: a `put` replaces the element where it exists or inserts it at its layer position (by key); a `del` removes it. Holders:
  - `History` undo and redo stacks (`History.rebase(ops)`);
  - every controller interaction's `before` snapshot (`controller.rebase(ops)`), and `textSession.before`;
  - the "Restore" buffer of the clear notice (§3.9).
- **Interactions work by id against the current state.** `move`, `resize` and `rotate` stop keeping the whole array as `base`. They keep `base: Map<id, SceneElement>` with only the items being changed (the selection plus dependents from `withDependents`). Each pointer move maps over the **current** `store.get().elements` and replaces only those ids, so items added or changed by others during a drag stay. If a remote `del` removes an item that is being dragged, `controller.rebase` drops it from `base` and `ids`, so the drag does not bring it back. A remote `put` to an item being dragged is shown again when the drag ends only if the drag is cancelled; otherwise the drag's later write wins (last writer wins, documented).
- `cancel()` and the restores at controller lines ~577, ~785, ~1046, ~1060 keep using `it.before.elements`, which is now rebased, so Esc after a drag keeps remote changes. `commitFrom(before)` records the rebased snapshot.
- **Undo is personal.** Because every snapshot is rebased, undo and redo only revert this tab's own steps; agent and other-tab changes stay. One documented edge case: if someone else changed an item after this tab created it, undoing the creation keeps their version. History length stays 200; a unit test checks a 5,000-element board with 200 snapshots rebases a 200-op batch in under 50 ms.

**Rule D — files are add-only in a session (fixes files lost by undo).**

- In a session, `files` only grows: `applyRemote` merges new file entries, and `Store.undo()`/`redo()` keep the **current** `files` map instead of restoring `prev.files` (in local-only mode, used by unit tests and `.chalana` preview, they behave as today). Unused file entries are harmless; the server cleans files of deleted sessions only. Test: an agent adds a picture and a video, the user undoes an earlier step, the picture and video still show.

**Reconnect and offline.** Exponential back-off (0.5 s to 10 s). Send `hello` with the last `rev`; resend `pending`. While offline, the status chip says "Offline — your changes will be sent when the connection is back"; unsent ops are mirrored to `localStorage["chalanamaya.pending.<id>"]` so a reload does not lose them. **Pictures and media need the server:** while offline, inserting a picture, GIF or video is refused with the notice "Pictures and media can be added when you are back online"; items already on the board keep working.

**Convergence test** (`src/sync/convergence.test.ts`, unit, no browser): two `Store` + `SyncClient` pairs and a scripted "agent" talk to a real `SessionService` (in-memory SQLite) through an in-process transport. Each tab uses a different text measurer (to simulate different font states). Script: tab 1 drags a box with two bound connectors and a label while the agent adds 20 items and edits 5; tab 2 edits a connector label and changes styles; tab 1 cancels a second drag with Esc and undoes twice. After all messages are delivered: both scenes and the server scene are equal (same ids, order, and element JSON), and **for the next 20 simulated seconds no tab sends a push**. A second test checks that the agent's 20 items exist after the drag, the cancel and both undos.

### 3.8 Text measured on the server

When the server creates or changes text for agents, `server/text/measure.ts` measures with `fontkit` using the same `.woff` files the app bundles (`@fontsource/kalam`, `source-sans-3`, `ibm-plex-mono`, latin subsets), installed with `setMeasure` in the server. Widths should match the browser to within a few percent, so agents get realistic sizes back. Because browsers can still differ slightly (hinting, fallback fonts), the server sets `needs_layout = 1` on text it laid out. The first browser that receives such an element, with fonts loaded, runs `finalizeScene` on just that element and its container (`touched`) and sends one `put` with `layout: true` (§3.6). If its result equals the server's, it sends a `layout: true` put with unchanged geometry only to clear the flag.

### 3.9 How the browser and agents share one scene

- Agents never touch raw rows. MCP tools call `SessionService.applyAgentChange(sessionId, mutate, {agentName})`, where `mutate` receives the current element array and returns a new one using the same pure functions the UI uses (`createShape`, `groupElements`, `reorder`, `alignElements`, `deleteElements`, `finalizeScene`…). The service diffs before/after by reference into ops (safe here: the input is the server's current array, and Rule A keeps untouched items identical) and applies them with `atomic: true` and `origin = {kind: "agent", name}`. So bindings, bound labels and frames behave exactly as when a person draws.
- **Layer keys for agent items:** new items get keys after the current top key (`generateNKeysBetween(topKey, null, n)`) in call order; a bound label gets a key between its container and the next item; `reorder_elements` gives new keys only to the moved items (front: after the top key; back: before the bottom key; forward/backward: between the next two neighbours). Browsers do the same through a shared `assignKeys(before, after)` helper that keeps existing keys when they are still in order.
- **Agent name.** `/mcp` runs in **stateless** mode (`sessionIdGenerator: undefined`, one `McpServer` + transport per request; nothing to expire, no "MCP session not found" after a restart). Every write tool takes an optional `agent_name` (for example "Claude"); without it the notice says "An agent". The stdio bridge fills `agent_name` from the desktop client's `clientInfo.name` when the agent leaves it out. Note: the MCP protocol's own "session" header is unrelated to the board `session_id`; docs say this clearly.
- Agent changes are remote changes, so a user's undo does not revert them (§3.7). To keep a safety net, an agent `clear_scene` shows a notice in open tabs, "Claude cleared the board · Restore"; Restore pushes the removed items back (a `put` with `baseVersion` equal to each tombstone's version, so rule 3 accepts it) as one local, undoable change.
- In the browser, agent changes get a soft lagoon outline for 1.5 s and, if they are off-screen, a notice "Claude added 6 items · Show" that zooms to them (AGENT-11).

### 3.10 Files in sessions

- `BinaryFile` becomes `{ id, mimeType, dataURL?: string, url?: string, source?: "upload" | "remote", width?, height?, size?, durationMs?, posterFileId? }`. Exactly one of `dataURL` or `url`.
- In a session, inserting a picture or media (menu, paste, drop) uploads it first (`POST /api/sessions/:id/files`, raw body) and the element points at `url = /api/sessions/:id/files/:fileId` (same origin). `insertImageBlob` goes through a small `FileStore` interface: `ServerFileStore` in the app, `MemoryFileStore` (data URLs) in unit tests.
- Saving a `.chalana` file, copying, and embedding scene data in PNG/SVG fetch each uploaded `url` file and inline it as a data URL, so files stay portable. Opening a `.chalana` file or importing the old localStorage board uploads its data URLs and swaps them for `url`s.
- `.chalana` `FORMAT_VERSION` becomes 2 (new element types, file `url`). Version 1 files keep opening.

## 4. Session lifecycle and URLs

- **Id:** 18 random bytes from `crypto.randomBytes` / `crypto.getRandomValues`, base64url → 24 characters (144 bits). Format check everywhere: `^[A-Za-z0-9_-]{24}$`. Element ids also move to random 96-bit ids so agents, tabs and the server cannot collide.
- `GET /` serves the app. The app calls `POST /api/sessions` and then `location.replace("/s/<id>")`. The session is created by JavaScript, not by the GET itself, so link previews, crawlers and prefetchers do not create empty boards. (The owner's "opening `/` creates a new session and redirects" is kept; the redirect happens in the page.)
- `GET /s/<id>` serves the app for any well-formed id. The app loads the session; an unknown id shows "This board does not exist (or was deleted)" with a **Start a new board** button. Bad formats get a 404 page.
- **No enumeration, anywhere.** No REST endpoint, MCP tool, MCP resource list or log line lists session ids. The MCP resource template `chalanamaya://session/{session_id}/scene` is registered with `list: undefined`, so `resources/list` returns only the static guide resources. "Recent boards" is kept in the browser only.
- **Main menu → Board session:** shows the title (editable) and a short id; **New board** (opens `/` in this tab; Ctrl/⌘+click for a new tab), **Copy board link**, **Copy session id**, **Connect an agent…** (dialog with the MCP address, the session id and ready-to-paste setup snippets), **Recent boards** (up to 20, kept in `localStorage["chalanamaya.sessions"]`), **Delete this board** (P2, confirm; `DELETE /api/sessions/:id`).
- **Old localStorage board (SESS-06):** localStorage belongs to one origin. The import works on the origin where the old board was saved: `http://localhost:5183` (old `npm run dev`, also the new default for `npm run dev` and `npm start`) or `http://localhost:5184` (old `vite preview`; start once with `PORT=5184`). If `chalanamaya.board.v1` holds elements and was not imported yet, a banner offers **Import it into this board** (into an empty session, or "add beside the current items" when the session already has content). Files are uploaded first, then elements are applied in one atomic batch (one undo step). The old key is kept and marked `chalanamaya.board.v1.importedTo = <id>`; the banner also offers **Remove the old copy**. The same import is in the main menu. The Board session menu shows a hint when no old board is found: "Saved a board with an older version at another address? Open that address once to import it."
- **Clean-up:** sessions that never had an element are deleted after 24 h. Other sessions are kept until deleted; an optional `SESSION_TTL_DAYS` deletes boards not opened for that long (off by default).
- **REST API** (JSON, all ids validated):
  - `POST /api/sessions` `{title?}` → `201 {session_id, url}`; `429 rate_limited`; `507 too_many_sessions`
  - `GET /api/sessions/:id` → `{session_id, title, rev, element_count, created_at, updated_at}`
  - `GET /api/sessions/:id/scene` → `{rev, elements, files, settings}` (full, used by tests, import and export)
  - `POST /api/sessions/:id/ops[?atomic=1]` `{ops}` → same result as a socket `ack` (phase 2 single-tab saving, tools, tests)
  - `POST /api/sessions/:id/files` (raw body, `Content-Type` = media type) → `{file_id, url, mime, size, width?, height?, duration_ms?}`; `413 too_large`; `415 unsupported_type`; `507 storage_full`
  - `GET /api/sessions/:id/files/:fileId` → bytes, supports `Range`
  - `DELETE /api/sessions/:id` → `204`
  - `GET /api/health` → `{ok: true, version}`

## 5. MCP server

### 5.1 Endpoints

- **Streamable HTTP:** `POST /mcp` on the app server, stateless (§3.9). `GET`/`DELETE /mcp` answer `405` (no server-sent streams are needed in stateless mode). `express.json({limit: "16mb"})` parses the body and the parsed body is passed to `transport.handleRequest(req, res, req.body)`, so the SDK's own 4 MB default (`DEFAULT_MAX_REQUEST_BODY_SIZE`) does not apply and a 10 MB base64 `upload_media` (≈13.4 MB of JSON) fits.
- **Host check for the whole app:** the SDK's `hostHeaderValidation(allowedHosts)` middleware runs before every route (app, REST, `/mcp`), and the WebSocket `upgrade` handler checks the same list. `allowedHosts` = `localhost`, `127.0.0.1`, `[::1]` with the port, plus the host of `PUBLIC_URL` when set (tunnels). The deprecated `allowedHosts`/`enableDnsRebindingProtection` transport options are not used.
- **stdio:** `node dist-server/stdio.js` (or `npm run mcp:stdio`, or `chalanamaya-mcp` after `npm link`), env `CHALANAMAYA_URL` (default `http://localhost:5183`). It creates `new StdioServerTransport()` with a 16 MiB read buffer (`maxBufferSize`; the SDK default `STDIO_DEFAULT_MAX_BUFFER_SIZE` is 10 MB, smaller than a 10 MB upload in base64) and forwards `tools/*`, `prompts/*`, `resources/*` to `/mcp` with an SDK `Client`. When the server cannot be reached, every call returns `isError` with "ChalanaMaya is not running at <url>. Start it with `npm start`."

### 5.2 Conventions for every tool

- Every board tool takes `session_id`. It accepts the bare id or a full board URL (`https://host/s/<id>`); the id is extracted and checked.
- **Coordinates:** board units; x grows to the right, y grows down; `(0, 0)` is the board origin. A new board at 100 % zoom shows about x 0–1280, y 0–800. Shapes, text, notes, frames and media are placed by their **top-left corner** with `width`/`height`. `angle` is in **degrees** clockwise (stored as radians). Points for paths are absolute board coordinates `[x, y]`.
- **Forgiving input:** missing `x`/`y` → the item is placed in free space to the right of existing content (reported back); missing size → sensible defaults (box 160×80, note 180×180, frame 800×600, web card 480×300, media 480 wide keeping its aspect ratio); colours accept palette names or hex; sizes accept names (`"s" | "m" | "l" | "xl"`, `"thin" | "bold" | "extra-bold"`); numbers given as numeric strings are accepted; unknown extra fields are ignored and listed in `warnings`.
- **How validation is split.** The SDK validates tool arguments with the zod `inputSchema` before our handler runs, and zod objects drop unknown keys silently. So the published schemas are deliberately **loose**: top-level fields have simple types (`session_id: string`, `elements: array`), element objects use `z.looseObject` with every field optional and `z.union([z.number(), z.string()])` for numbers. The handler then validates strictly per element type and returns our own messages with a path and a hint, and warnings for unknown keys. Only a wrong top-level type (for example `elements` not an array) gets the SDK's generic "Input validation error".
- **Flat element schema.** The element input JSON Schema is one object with a `type` enum and all fields listed once with descriptions saying which types use them, not a deep `anyOf`, because some clients handle big unions poorly. The per-type rules are in the handler and in `chalanamaya://reference/elements`.
- **Batches are atomic:** a call either applies all changes in one server rev (one broadcast) or none (`SessionService.apply(…, {atomic: true})`, §3.6).
- **Locked items** (ARR-10) are refused by `update_elements`, `move_elements`, `set_style`, `delete_elements`, `group_elements` and `reorder_elements` with the error `<id> is locked; unlock it first`; `update_elements` with `locked: false` unlocks (and may change the item in the same update). `clear_scene` removes locked items too, like the Clear canvas action.
- **Errors** return `isError: true` with a precise path and a hint, for example: `elements[2].to: no element or key "b9" in this board or this call. Known keys: start, decision.`
- **Output:** every tool returns `structuredContent` (with an `outputSchema`) and the same JSON as text content for clients that only read text.
- **Palette names** (from the approved swatches): stroke `ink #193a36`, `lagoon #007f78`, `clay #b65b24`, `berry #c0392b`, `sky #2f6fb5`, `moss #6b8e23`; fill `none`, `mint #bfe8e2`, `peach #ffd9b8`, `rose #f7c6c1`, `cloud #c9dcf5`, `sage #e3edc2`; notes `butter #ffe59a`, `apricot #ffd2b0`, `seafoam #c9efe6`, `mist #d6e4fb`, `blush #f6d0e2`.

### 5.3 Shared input shapes

Written as TypeScript for readability; the published JSON Schema is the flat form described in §5.2.

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
               poster_file_id?: string }
  | Common & { type: "web_card"; url: string }                    // stored as the existing "embed" type
  | Common & { type: "component"; preset?: PresetName; params?: Record<string, string | number>;
               html?: string; css?: string; title?: string };
type Point = [number, number];
```

Connector rules: `from`/`to` with a `Ref` bind the end to that shape, note, frame, image or media item (the existing binding code places the end on the outline and keeps it attached when the shape moves); a `Point` leaves the end free. `points` (optional) adds bend points in between.

### 5.4 Tool list

Every write tool also takes the optional `agent_name` (§3.9).

| Tool | Input (besides `session_id`) | Output |
| --- | --- | --- |
| `create_session` | `title?` (the only tool without `session_id`) | `{session_id, url}` |
| `get_session_info` | — | `{session_id, url, title, rev, element_count, open_tabs, bounds, background, grid}` |
| `update_session` | `title?`, `background?` (board colour name or hex from the board swatches), `grid?: boolean` | `{rev, title, background, grid}` |
| `get_scene` | `format?: "json" \| "outline"` (default json), `ids?`, `region?: {x,y,width,height}`, `query?` (text search), `limit?` (≤ 500, default 200), `cursor?` | `{rev, bounds, count, elements: CompactElement[], next_cursor?, free_space: {x, y}}` or `{rev, outline: string}` |
| `add_elements` | `elements: ElementInput[]` (1–200) | `{rev, created: [{key?, id, type, x, y, width, height}], warnings: string[]}` |
| `update_elements` | `updates: ({id} & Partial<ElementInput without type>)[]` (1–200) — text, label, name, url, points, from/to, geometry, style, locked, link, media settings | `{rev, updated: string[], warnings}` |
| `move_elements` | `ids`, either `dx`/`dy` or `to: {x, y}` (new top-left of the group's box) | `{rev, moved: string[], bounds}` |
| `set_style` | `ids`, `style: StyleInput` | `{rev, updated: string[], skipped: [{id, reason}]}` (e.g. fill on a text) |
| `delete_elements` | `ids` (labels go with their shape; connectors to deleted items are unbound) | `{rev, deleted: string[]}` |
| `group_elements` / `ungroup_elements` | `ids` | `{rev, group_id?}` |
| `reorder_elements` | `ids`, `to: "front" \| "back" \| "forward" \| "backward"` | `{rev}` |
| `arrange_elements` | `ids` (≥ 2), `align?: "left" \| "center" \| "right" \| "top" \| "middle" \| "bottom"`, `distribute?: "horizontal" \| "vertical"`, `gap?` | `{rev, bounds}` |
| `clear_scene` | `confirm: true` (required) | `{rev, deleted_count}` |
| `upload_media` | `data_base64`, `mime_type`, `filename?` (≤ 10 MB decoded for pictures/GIFs, ≤ 25 MB for videos up to the 16 MB request cap, see §7) | `{file_id, mime_type, size, width?, height?, duration_ms?}` |
| `place_media` | `kind: "image" \| "gif" \| "video"`, `source: {file_id} \| {url} \| {data_base64, mime_type}`, `x?`, `y?`, `width?`, `height?`, `autoplay?`, `loop?` | `{rev, id, file_id, warnings}` (a `{url}` source warns that remote media is shown in the live layer and exported as a placeholder, §6.3) |
| `list_component_presets` | `session_id` optional | `{presets: [{name, description, params: {name, type, default}}]}` |

`CompactElement` (only non-default fields; layer order back to front; bound labels folded into their shape):

```json
{ "id": "k3f…", "type": "rectangle", "x": 100, "y": 80, "w": 160, "h": 80, "label": "Start",
  "stroke": "ink", "fill": "mint", "fill_style": "solid", "group": "g1", "frame": "f1" }
{ "id": "a9…", "type": "arrow", "from": "k3f…", "to": "p0q…", "label": "yes", "points": [[260,120],[400,120]] }
{ "id": "z1…", "type": "freedraw", "x": 0, "y": 0, "w": 90, "h": 40, "point_count": 120 }
{ "id": "m2…", "type": "video", "x": 600, "y": 80, "w": 480, "h": 270, "file_id": "…", "mime": "video/mp4", "source": "upload" }
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
- Templates `chalanamaya://session/{session_id}/scene` and `…/outline` — read-only views of a board; registered with `list: undefined` (§4).

Skill (`skills/chalanamaya/SKILL.md`, YAML front matter `name`, `description`, portable to Claude Skills and other agents): what ChalanaMaya is; the coordinate system; a 40-unit layout grid and spacing rules (80 between boxes, 160 between rows); size and font guidance; how to use `key` and `from`/`to`; colour meaning (lagoon = main path, clay = attention, notes for comments); a workflow (get_scene → plan → add in batches → verify → tidy); recipes for flowchart, mind map, timeline, architecture, sequence and wireframe; media and component examples ("upload media for full support; links show in the live layer"); pass `agent_name`; limits and common errors. `skills/chalanamaya/reference.md` holds copy-ready JSON examples.

## 6. Media element model and rendering

### 6.1 Model

| Content | Element | Notes |
| --- | --- | --- |
| Animated GIF | existing `image` element whose file is `image/gif` | Keeps crop and flip. New optional field `paused?: boolean`. |
| Video | new `VideoElement` `type: "video"`: `fileId`, `autoplay` (true), `loop` (true), `paused?` | `fileId` points at an uploaded or remote file; poster at `files[fileId].posterFileId`. **Mute is not stored**: every tab starts muted and unmuting is personal to the tab (browsers block unmuted autoplay, so a synced "unmuted" would stop the video in other tabs). Synced: `paused`, `loop`, `autoplay`. |
| CSS component | new `ComponentElement` `type: "component"`: `source: {kind: "preset", preset, params} \| {kind: "custom", html, css}`, `title`, `paused?` | Rendered in the HTML live layer. |

All new elements reuse `BaseElement`, so move, resize (keep aspect with Shift for media, like pictures), rotate, select, group, layer order, lock, frames, links, undo/redo and sync work without special cases. `parseElement`, `hit.ts`, `geometry.ts`, `transform.ts`, `svg.ts`, `renderScene.ts`, the properties panel and the compact agent view each get the new types.

### 6.2 Two kinds of media source

| | **Uploaded** (`source: "upload"`, same origin `/api/sessions/:id/files/…`) | **Remote link** (`source: "remote"`, an https URL) |
| --- | --- | --- |
| Who loads the bytes | the browser, same origin | the browser, directly from the other site (the **server never fetches** remote URLs, so no server-side request forgery) |
| Where it is drawn | on the **board canvas**, in layer order | in the **HTML live layer** (like web cards), with a canvas placeholder underneath |
| GIF animation | yes (bytes fetched same-origin, decoded, §6.3) | yes, as a plain animated `<img>` |
| Video | `<video>` without `crossOrigin` (not needed for same origin) | `<video>` **without `crossOrigin`**, so sites without CORS headers still play |
| Layer order | exact | above drawn items (the documented live-layer limit, risk 1) |
| PNG export | first frame / poster | placeholder card with the host name (§6.4) |

Why: a remote GIF needs its bytes to animate on a canvas, but `connect-src 'self'` and missing CORS headers block `fetch()`; `drawImage` of an `<img>` GIF paints one frame only; `crossOrigin="anonymous"` makes non-CORS videos fail to load; and drawing non-CORS media on the canvas taints it, which breaks the eyedropper. Showing remote media in the live layer avoids all four: the board canvas only ever draws same-origin or data-URL pixels, so it is **never tainted**. Users and agents are told: "Upload for full support (exact layering, export frames); links are shown as live items." The opt-in SSRF-guarded server fetch stays an open question (§12).

- **Eyedropper guard:** `onSample` wraps `getImageData` in `try/catch`; on a `SecurityError` it samples an offscreen canvas rendered from the scene without media and shows "Can't pick a colour from this media". A unit test fakes the throw.
- **Remote URL rules** (`src/shared/urls.ts`, used by browser and server): `https:` only; no user/password; at most 2,048 characters; the host must have a dot (no single-label hosts); refused: IP literals (IPv4 in any form, including decimal and hex, and IPv6), `localhost`, `*.localhost`, `.local`, `.internal`, `.lan`, `.home.arpa`, `.intranet`, `.corp`. The browser still loads the URL, so these rules protect the user's network from links that agents or others place.

### 6.3 Rendering

- **Uploaded GIF and video are drawn on the board canvas**, so layer order, rotation, opacity, crop, the board overview and Spotlight work like other items.
  - GIF: `ImageDecoder` (WebCodecs) decodes frames on demand from the same-origin bytes (keeps at most 3 `ImageBitmap`s per GIF). Without `ImageDecoder`, `gifuct-js` decodes, limited to 50 million pixels in total (width × height × frames); bigger GIFs show their first frame with a notice.
  - Video: a `<video playsInline muted loop preload="none">` per element, **created only while the item is on screen** and released (`src` removed, `load()`) 5 s after it leaves the screen; `preload="auto"` only while playing. `drawImage(video)` paints the current frame. At most 6 videos play at once (the rest show their poster with a play badge).
- **Animation loop and frame budget** (`src/media/loop.ts`): `requestAnimationFrame` runs only while a playing GIF or video is visible and the tab is visible.
  - **Partial redraw:** an animation frame repaints only the union of the screen rectangles of animated items (clip), redrawing the elements that intersect that clip in layer order from the existing drawable cache. A full redraw happens only when the view or the scene changes.
  - **Budget:** the loop measures each frame's cost (`performance.now()`, moving average over 30 frames). Target rate 30 fps. Average > 12 ms → 15 fps; > 25 ms → 10 fps; still > 25 ms at 10 fps for 2 s → pause all animations with the notice "Moving media paused to keep the board responsive · Play"; it steps back up after 5 s under budget. `prefers-reduced-motion` starts everything paused.
  - Controls: properties panel buttons Play/Pause, Mute/Unmute (videos, this tab only), Loop, Restart, plus a play badge on the item itself. No new single-key shortcut (Space keeps its pan meaning). Sound only after a user action.
- **Live layer** (today's `WebCards` layer, renamed `LiveLayer`): web cards, CSS components and remote GIFs/videos.
  - **Cap:** at most **24 live items mounted** at once. Candidates are on-screen live items, ranked: the active web card, selected items, then larger on-screen area. Items beyond the cap, items smaller than 48 screen pixels, and everything when zoom is below 30 % are drawn as their static fallback on the canvas (§6.4) instead of being mounted.
  - **Selection above live items:** the overlay (selection frames, handles, snap lines, the lasso) moves from the scene canvas to a new `TopOverlay` canvas stacked **above** the live layer with `pointer-events: none`, so selected live items show their frame and handles. Scene canvas → live layer → top overlay → UI.
  - Within the live layer, items follow board layer order, but the layer sits above the canvas (risk 1).
- **CSS components:** each is an `<iframe sandbox="" srcdoc="…" referrerpolicy="no-referrer" loading="lazy">` — **no `allow-scripts`, no `allow-same-origin`**, so it is a unique origin that can run no script, open no popups and submit no forms. `pointer-events: none` always (components are look-only), so the board handles selection and dragging. Paused components get `animation-play-state: paused` injected.
- **Component content:**
  - Presets (built-in templates from `src/shared/presets.ts`; parameters are typed and validated, no free text goes into CSS): `pulse` (dot with colour), `spinner` (colour, speed), `typing-dots`, `progress-bar` (value 0–100, colour, label), `shimmer-card` (lines), `marquee` (text, speed), `bounce-arrow` (direction, colour), `gradient-wave` (two palette colours). Text parameters are HTML-escaped.
  - Custom: `html` ≤ 20 KB and `css` ≤ 20 KB. The server checks sizes and rejects obvious bad content with clear messages (`<script`, `on*=` attributes, `javascript:`, `@import`, `url(` other than `data:image/png|jpeg|gif|webp`, `<iframe`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`, `<form>`). At render time the browser runs DOMPurify with an allow-list (layout and text tags, inline `svg` shapes, attributes `class`, `id`, `style`, `aria-*`, `role`; no `href`/`src` except `data:` images) and a CSS filter for the same patterns. The `srcdoc` starts with `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`. Three layers: server check, sanitiser, sandbox without scripts.

### 6.4 Export and file fallbacks

| Item | PNG export / copy as PNG / board overview | SVG export | `.chalana` file |
| --- | --- | --- | --- |
| Uploaded GIF | first frame | `<image href="data:image/gif…">` (browsers animate GIFs inside SVG) | inlined file |
| Uploaded video | poster frame + small play badge; placeholder card ("Video · name") if no poster | poster `<image>` + play badge | inlined file under 50 MB total, otherwise kept as a link with a warning |
| Remote GIF or video | placeholder card with the host name and a play badge (never drawn from the remote pixels) | placeholder card wrapped in `<a href>` to the URL | link only |
| Component | static card: title and "Animated component" (presets draw a simple still picture) | same static card as SVG shapes | the element data (HTML/CSS) |

Posters: when a browser first plays an uploaded video that has no poster, it captures a frame at 0.1 s, uploads it as a PNG and sends a `poster` op (§3.6; not in history). Remote videos have no poster; the placeholder is used.

## 7. Security limits

- **Access model:** no accounts in this round. The **session id is the access token**: anyone (person or agent) who has it can read and change the board. 144 random bits; never logged in full (logs show the first 4 characters); never listed (§4); `Referrer-Policy: strict-origin-when-cross-origin` so other sites see only the origin, never `/s/<id>`; the "Connect an agent" dialog and docs say "treat the link like a password". Documented in `docs/security.md` and in SESS-08.
- **Binding:** listens on loopback (127.0.0.1 and ::1) by default. Exposing it (`HOST=0.0.0.0`, or a tunnel for Devin and ChatGPT) is an explicit choice; docs recommend HTTPS in front and setting `PUBLIC_URL`.
- **Host check:** SDK `hostHeaderValidation` on every route and on socket upgrades (§5.1). WebSocket upgrades must also come from an allowed `Origin`.
- **Input validation:** zod for every REST body and socket message; strict handler validation for MCP input (§5.2); `parseElement` for every stored element; ids checked by format; file references checked against the session's own files.
- **Per-session caps (defaults, all configurable):** 5,000 live elements; 64 KB per element JSON; 10 MB per session scene JSON; 10,000 characters per text; 5,000 points per pencil path; 500 ops / 2 MB per socket message; 2 MB REST JSON; 16 MB MCP JSON; 200 elements per MCP call; pictures and GIFs 10 MB, videos 25 MB per file (MCP base64 uploads are capped by the 16 MB request, about 11.9 MB of bytes; larger videos are uploaded from the UI); 200 MB media per session; 50 sockets per session.
- **Global caps (new, defaults, configurable):** `MAX_SESSIONS = 10000` → `507 too_many_sessions` (REST) / MCP error; `MAX_TOTAL_MEDIA_BYTES = 5 GiB` (sum of `blobs.size`) → `507 storage_full`; `MAX_DB_BYTES = 1 GiB` (`page_count × page_size`, checked before each write batch) → `507 storage_full` and socket `error {code: "storage_full"}`. The browser shows "The ChalanaMaya server is full. Ask its owner to free space." Reads keep working. Integration tests run with tiny limits.
- **Media checks:** allowed types `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `video/mp4`, `video/webm`; the first bytes must match the claimed type (magic numbers); no SVG uploads. Served with the sniffed type, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, max-age=31536000, immutable`.
- **No server-side fetching** of remote media (no SSRF). Remote URL rules in §6.2.
- **Rate limits** (`express-rate-limit`, per IP, configurable with `RATE_LIMITS=off` or per-limit env vars): 30 new sessions per minute, 60 uploads per minute, 600 MCP requests per minute; socket pushes limited to 50 per second per connection. Playwright and integration tests run with `RATE_LIMITS=off`, except the test that checks the limits.
- **Headers for the app (production):** CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.figma.com https://codepen.io; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`. (`srcdoc` frames inherit this policy and add their own stricter one.) Dev mode relaxes `script-src` and `connect-src` for Vite (§3.4).
- **No secrets in the repo:** config only from environment; `.env` files ignored; tests use temp data folders.
- **Components:** see §6.3 (no script execution, three layers).

## 8. Testing strategy

**Unit (Vitest `app` project, Node):**
- ids: length, alphabet, entropy source; session URL parsing (`session_id` as id or URL).
- `finalizeScene` identity: `finalizeScene(finalizeScene(s)) === finalizeScene(s)` for straight, curved and elbow connectors and labels; scoped `touched` recomputes only dependents.
- Store `LocalChange` diff: a move reports only moved items and their connectors; `applyRemote` reports nothing.
- `rebaseElements`, `History.rebase`, `controller.rebase`: put/insert at key/delete; 50 ms performance case; files kept on undo/redo in session mode.
- Controller by-id interactions: while a move, resize, rotate, text edit and freedraw are in progress, remote puts/dels arrive; after pointer moves, Esc, commit, undo and redo, every remote item is still there and no `del` is produced for it.
- Convergence test (§3.7) with two tabs, an agent and different text measurers; quiet after convergence.
- Agent input → elements: every type, defaults, palette names, degrees → radians, `key`/`from`/`to` resolution, atomic failure, unknown-field warnings, error messages (snapshot of messages).
- Compact view and outline: default fields omitted, labels folded, order, paging, size cap.
- Media: magic-number sniffing, remote URL rules (including single-label and `.internal` hosts), GIF pixel budget, frame-budget state machine (fake clock), live-layer cap ranking, eyedropper `SecurityError` fallback.
- Components: sanitiser with a corpus of attacks (script tags, `onerror`, `javascript:` URLs, `@import`, external `url()`, `<meta refresh>`, SVG `<foreignObject>` and `<a>`, CSS `expression`); preset parameter validation and escaping.
- Esc fix: controller/App logic for leaving an active card.

**Server and integration (Vitest `server` project, `pool: "forks"`, real server on a random port 5000–5999 with a temp `DATA_DIR`):**
- `db:smoke` and `SessionService` with in-memory SQLite: modes `atomic` on and off, tombstone rule, layout correction rule, poster op, `unknown_file`, quotas (session, global media, DB size) with tiny limits.
- REST: create, read, ops, files (upload, Range, wrong type, too big), delete, 404s, size limits, rate limits (one test with limits on), host header refused.
- Sockets: two `ws` clients converge; reconnect with `sinceRev`; old `sinceRev` gets a snapshot; tombstone rejection; message too large; the sender does not receive its own `changes`.
- MCP over HTTP with the SDK `Client` + `StreamableHTTPClientTransport`: `listTools` matches the documented list (test fails if `docs/agents/mcp-tools.md` misses a tool); every tool's happy path and main errors; unknown fields give warnings; prompts and resources list and read; `resources/list` contains no session ids; a 10 MB `upload_media`; an MCP change reaches a socket client as `changes` with `origin.kind = "agent"` and the given `agent_name`; a socket change is seen by `get_scene`; a fresh client works after a server restart (stateless).
- MCP over stdio with `StdioClientTransport` spawning the built `dist-server/stdio.js` against the running server: smoke set plus a 10 MB `upload_media`; unreachable server gives the clear error.

**End to end (Playwright, Chromium, built server on port 5184, `RATE_LIMITS=off`):**
- All existing specs keep running. `e2e/helpers.ts` changes once: `freshBoard` opens `/` (new session each test) and `storedElements` reads `GET /api/sessions/<id>/scene`, polling until the client is idle. Specs that read localStorage directly (`p1.spec.ts`, `revision.spec.ts`, theme in `smoke.spec.ts`) switch to the same helper; preference checks keep reading `chalanamaya.prefs`.
- `sessions.spec.ts`: `/` redirects to `/s/<24 chars>`; reload restores the board; New board gives a new id; copy link/id; unknown id page; **legacy import on the served origin:** `page.addInitScript` seeds `chalanamaya.board.v1` (two shapes and a picture) on `http://localhost:5184` before the first visit; the banner appears, import brings everything in as one undo step, the old key stays until **Remove the old copy**.
- `sync.spec.ts` (phase 3): two pages on one session see each other's edits within 1 s; undo in one does not undo the other's work; offline edits arrive after reconnect.
- `agent.spec.ts`: the test process connects an MCP SDK client to `http://localhost:5184/mcp`, calls `add_elements` (two boxes, a bound connector, a note) and the items appear on the open page within 2 s without reload, with the agent notice; then the user drags a box and `get_scene` reports the new position and the connector still bound. **Edits during a drag:** the user holds a drag (mouse down, several moves) while the agent adds 3 items and changes the colour of another; the user keeps moving, releases, then repeats and presses Esc, then presses undo twice: the agent's 3 items and the colour change are still on the page and in `get_scene`.
- `media.spec.ts`: upload a GIF (two-frame fixture) and a WebM/MP4 fixture (a few KB, made with ffmpeg and committed in `e2e/fixtures/`); move, resize, rotate, layer, group, lock, undo; frames change over time (pixel sampling); PNG export works and shows the poster; a remote GIF URL (served by a tiny second test server on another port in 5000–5999 without CORS headers) animates in the live layer and the eyedropper still works; agent `place_media` adds a video live; an agent adds a picture, the user undoes an earlier step, the picture stays.
- `perf.spec.ts`: seed (through the API) 2,000 shapes, 4 uploaded GIFs and 3 uploaded videos in view; with `?perf=1` the app exposes the loop's frame statistics; over 5 s the average animation frame cost is under 16 ms, or the loop has stepped down to 15/10 fps by itself; with an injected 30 ms delay per frame (`?perf=slow`), the loop reaches 10 fps and then pauses with the notice. 30 components and 10 remote videos on screen mount at most 24 live items.
- `components.spec.ts`: add a preset and a custom component; the iframe has `sandbox=""`; a custom component with `<script>`, `onerror` and `javascript:` does nothing (a `window.__pwned` probe stays undefined and no console errors from the frame); it moves and resizes like other items, and its selection frame is visible above it.
- Web card Esc (phase 1): activate by double-click → Esc leaves; activate by Enter → Esc leaves; after clicking into the page, the **Done** button leaves.

## 9. Docs updates

- `docs/out-of-scope.md`: board-session sync is in scope, real collaboration stays out (done with this plan; round 2 makes it precise: several tabs or agents editing one session through this server; no accounts, presence, cursors, permissions, hosted service or merging inside one item).
- `docs/README.md`: index entries for specs 06 and 07, scope paragraph, status table rows per phase.
- `docs/features/05-save-open-export.md` (phase 2): FILE-01 changes meaning: the board is saved on the ChalanaMaya server for the session; the browser keeps only unsent changes, preferences and recent boards. FILE-02 notes format version 2 (phase 5).
- `docs/features/01-drawing-tools.md` (phase 1): DRAW-14 acceptance gains "Esc or Done returns to the board".
- New: `docs/agents/setup.md` — Claude Desktop (stdio: `{"command": "node", "args": ["/absolute/path/ChalanaMaya/dist-server/stdio.js"], "env": {"CHALANAMAYA_URL": "http://localhost:5183"}}`), Claude Code (`claude mcp add --transport http chalanamaya http://localhost:5183/mcp`), Cursor / VS Code / generic (HTTP URL or the stdio command). **Devin and ChatGPT run in the cloud and cannot reach `localhost`:** they need a public HTTPS tunnel (for example `cloudflared tunnel --url http://localhost:5183` or ngrok) with `PUBLIC_URL` set to the tunnel address; the doc warns that the session id is then the only protection. Also: the import note for old boards (origins), and the `better-sqlite3` pin.
- `docs/agents/mcp-tools.md` (every tool with examples), `docs/security.md`, root `README.md` (how to run; it still says "specifications only").
- `skills/chalanamaya/SKILL.md` and `reference.md`.

## 10. Risks

1. **Live-layer layer order.** CSS components, web cards and remote media sit above the canvas, so a box drawn on top of them still shows under them. Mitigation: documented; uploaded GIF and video draw on the canvas; the top overlay keeps selection visible. A later fix is "band canvases" (split the scene into canvas layers between live items).
2. **Sync correctness.** Echo loops and lost edits are the main risk. Mitigation: Rules A–D (§3.7), the removal guard, the convergence unit test, and the drag e2e test. If rebasing turns out too fragile, a fallback is to make history store change lists instead of snapshots.
3. **Text sizes differ** between server and browser. Mitigation: `fontkit` with the same fonts, plus the one-time `needs_layout` correction.
4. **Last-writer-wins can drop a change** when two people edit the same item at the same moment (including a drag against an agent edit). Acceptable for board-session sync; documented. Deletes are protected by the tombstone rule.
5. **`better-sqlite3` is a native module.** Verified: 13.x crashes on this VM, 12.11.1 works. Mitigation: exact pin, start-up and CI smoke test; **any upgrade must be re-verified with `npm run db:smoke` on Node 22 before it lands**. Systems without prebuilt binaries need build tools (documented).
6. **Remote media is second class** (live layer, placeholder in exports). Mitigation: clear warnings in `place_media` results, UI and skill; agents can download and `upload_media` themselves; opt-in server fetch is open question 2.
7. **Performance with many moving items.** Mitigation: partial redraw, adaptive frame rate and pause, video and live-item caps, the perf e2e test.
8. **GIF memory.** Large GIFs can use a lot of memory. Mitigation: on-demand decoding and a pixel budget.
9. **Client differences.** Cloud agents need a public HTTPS address; some clients ignore resources or prompts or handle big schemas poorly. Mitigation: flat schemas, the same guidance as prompts, resources and a skill file; the stdio bridge for desktop clients.
10. **Session id leaks** (screenshots, shared history, chat logs given to agents) and **open servers** (a tunnel lets anyone create sessions). Mitigation: clear warnings, rate limits, global caps, delete board (P2); real authentication is a future project.
11. **Test churn.** Moving the e2e suite to the server touches every spec through the helpers. Mitigation: done in phase 2 with all specs green before new features.
12. **Single process.** Sessions are in one process; no horizontal scaling. Documented.

## 11. Implementation phases

Each phase ends with `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and `npm run test:e2e` green, its specs' status updated in `docs/README.md`, and a conventional commit on `main`. Each phase can ship alone: users get a working app after every phase.

### Phase 1 — Esc fix, sync-ready scene code and the server shell (SESS-10, DRAW-14 fix)

Delivers:
- **Esc fix:** stop calling `focus()` on the iframe (`WebCards.tsx` lines 32–39); focus the card wrapper (`tabIndex=-1`) so the board document keeps keyboard focus and Esc works right after activation; a **Done** button in the active hint bar (outside the iframe); watch `window` `blur` while `document.activeElement` is the frame to show "Click Done or the board to return" (browsers do not pass key presses out of a cross-origin page); return focus to the board on leave. DRAW-14 acceptance updated.
- **Rule A** (identity-keeping and scoped `finalizeScene`) and **Rule C's controller part** (move/resize/rotate by id against the current state; `SnapshotRegistry`, `History.rebase`, `controller.rebase` with unit tests, not yet wired to a server). No visible change for users.
- Canvas measurer moved to `src/ui/measure.ts`; `tsconfig.server.json`; Vitest projects.
- The Node server (`server/`): config, SQLite schema and migrations, `db:smoke`, `SessionService` (apply with both modes, quotas), the REST API of §4, picture uploads, security headers, host check, configurable rate limits, `npm run dev`/`build`/`start` on `localhost:5183`. Playwright runs against the built server on 5184. The app itself still saves to localStorage.

Acceptance:
- Double-click a YouTube web card, press Esc: the card is no longer active (`webcard-active` gone) and board shortcuts work again. Same after Enter activation. After clicking inside the page, **Done** returns to the board. New e2e test covers all three.
- Unit: `finalizeScene` is idempotent by identity (same array object on the second call) for every connector routing; scoped finalize changes only dependents; a move frame computed while a remote item is inserted keeps that item.
- `npm start` prints `http://localhost:5183` and serves the app at `/` and `/s/<id>` exactly as before; `GET /api/health` returns `{ok: true}`; start-up fails with a clear message if the database smoke check fails.
- `package.json` pins `better-sqlite3` to `12.11.1`; `npm test` runs `db:smoke`.
- Integration: `POST /api/sessions` returns a 24-character id; ops are validated with `parseElement`; `atomic` rolls back on one bad op; oversized bodies get 413; bad ids get 404; uploads check magic bytes and limits; `Range` requests return 206; `MAX_SESSIONS`, `MAX_TOTAL_MEDIA_BYTES` and `MAX_DB_BYTES` return 507 with tiny limits; a wrong `Host` header is refused.
- Existing unit and e2e suites pass unchanged except for the Playwright `webServer` command.

### Phase 2 — Server-backed sessions in one tab (SESS-01…03, SESS-05, SESS-06, SESS-08)

Delivers: `/` → new session → `/s/<id>`; the board loads from `GET /api/sessions/:id/scene` and saves through `POST /api/sessions/:id/ops` (debounced, built from the Store's `LocalChange` dirty sets, Rule B), replacing localStorage autosave for sessions; Rule D (files add-only, undo keeps files); pictures uploaded to the server; `.chalana` save/open inlining files; Board session menu (title, New board, Copy link, Copy session id, Recent boards); a simple Saved/Saving/Not saved status; legacy localStorage import; FILE-01 spec rewritten; e2e helpers read the server. Two tabs on one session do not update each other live yet (documented as temporary; the later save of an item wins).

Acceptance:
- Opening `/` lands on `/s/<24 chars>`; reload restores elements, pictures and board colour/grid; theme and viewport stay per browser; unknown ids show the "does not exist" page.
- A normal drag of a box with two bound connectors sends one save containing only the box and the two connectors (checked in a unit test on the dirty sets and an integration count).
- Undo after inserting a picture and then another edit keeps the picture file (unit test, Rule D).
- E2E: the old `chalanamaya.board.v1` key seeded on the served origin shows the import banner; import brings in elements and pictures as one undo step; the old copy stays until removed.
- All existing e2e specs pass on the server-backed app (42 tests plus the new ones).

### Phase 3 — Live sync between tabs (SESS-04, SESS-07)

Delivers: the WebSocket protocol of §3.6, `SyncClient` (pending over confirmed, ack, reject notice, layer key repair), `applyRemote` wired to the `SnapshotRegistry` (history, controller, text session), the `needs_layout` correction, reconnect with `sinceRev`, the offline chip and offline queue (media refused while offline), the removal guard.

Acceptance:
- Unit: the two-tab convergence test passes and no tab pushes after quiescence; the removal guard never fires in the suite.
- Two pages on the same session: a box drawn in one appears in the other within 1 s; a delete in one removes it in the other; undo in one does not undo the other's work; a change to an item the other tab deleted shows the notice and is not kept.
- An item added by the second page while the first page is dragging, cancelling with Esc and undoing is still there afterwards in both pages and on the server.
- Going offline (Playwright `context.setOffline`) shows the offline chip; edits made offline arrive after reconnect, also after a reload; inserting a picture offline shows the notice.

### Phase 4 — MCP server, skill and setup docs (AGENT-01…11, AGENT-13)

Delivers: stateless `/mcp` with the 16 MB body, the stdio bridge with the 16 MiB buffer, all tools of §5.4 (media tools accept pictures in this phase), loose schemas with strict handler validation, `agent_name`, prompts, resources (no session listing), server text measuring with `fontkit`, `skills/chalanamaya/`, `docs/agents/setup.md`, `docs/agents/mcp-tools.md`, `docs/security.md`, the Connect an agent dialog, agent highlight and notice, clear-with-Restore.

Acceptance:
- SDK client integration tests pass for every tool, prompt and resource over HTTP, and for a smoke set plus a 10 MB upload over stdio; a new client works after a server restart.
- `listTools` equals the documented list; each input schema is flat with descriptions; invalid inputs return `isError` with the field path; unknown fields return warnings; a batch with one bad element changes nothing.
- E2E `agent.spec.ts`: an MCP `add_elements` call (boxes, bound connector, note, frame) shows live in the open page within 2 s with the "Claude added items · Show" notice; a user drag is visible in `get_scene` and the connector stays bound; agent edits during a user's drag, Esc and undo are all kept.
- An agent following only `SKILL.md` can draw a 6-step flowchart with labelled, bound connectors in one `add_elements` call (an integration test uses the skill's own flowchart example verbatim).
- Server-measured label widths are within 5 % of the browser's for the three fonts (e2e compares a few strings).

### Phase 5 — GIF and video elements (MEDIA-01…04, MEDIA-07…10)

Delivers: uploaded GIF playback on the canvas, the `video` element, remote GIF/video in the live layer with placeholders, the eyedropper guard, upload from file and link in the UI (Insert media dialog, drop, paste of files), playback controls (mute per tab), the animation loop with partial redraw and frame budget, video and live-item caps, the top overlay, reduced motion, posters, export fallbacks, `.chalana` version 2, MCP `upload_media`/`place_media`/`add_elements` for `gif` and `video`.

Acceptance:
- A dropped GIF animates on the board (pixel sampling changes over time), can be paused, cropped and flipped. A remote GIF link without CORS animates in the live layer and the eyedropper still works.
- A dropped MP4 or WebM plays muted and looped; Play/Pause/Mute/Loop/Restart work; unmuting in one tab does not unmute another; with `prefers-reduced-motion` GIFs and videos start paused.
- GIF and video move, resize, rotate, group, lock, change layer order (a box above an uploaded video hides part of it), undo/redo and sync to a second tab.
- PNG export shows the GIF's first frame and the video's poster with a play badge, and a placeholder for remote media; SVG export embeds the GIF; a `.chalana` save reopens with media.
- Oversized, wrong-type and SVG uploads are refused with a clear message; remote URLs with private, single-label or `.internal` hosts are refused.
- `perf.spec.ts` passes (2,000 shapes + 4 GIFs + 3 videos under budget or stepped down; slow mode pauses; at most 24 live items mounted).
- An agent `place_media` with a video file appears live in the browser (e2e).

### Phase 6 — Animated CSS components and hardening (MEDIA-05, MEDIA-06, SESS-09)

Delivers: `component` element, presets, custom HTML/CSS dialog with live preview and limits, sanitiser, sandboxed `srcdoc` rendering in `LiveLayer` (inside the 24-item cap), static fallbacks for export, MCP support (`add_elements` type `component`, `list_component_presets`, resource); delete board; empty-session clean-up and optional TTL; performance checks (5,000 elements: load < 2 s, remote batch of 200 applied < 100 ms); final pass on all docs and the root README.

Acceptance:
- Each preset can be added from the UI and by an agent, with parameters; it animates and moves/resizes/rotates/groups/locks/undoes like other items, with its selection frame visible.
- Every component iframe has `sandbox=""` (checked in e2e); the attack corpus does not execute script, load remote resources or navigate (e2e probe and unit corpus).
- Custom HTML/CSS over 20 KB, or with forbidden content, is refused with a message naming the rule; the UI dialog shows the same rule.
- PNG/SVG exports show the static card; `.chalana` round trip keeps components; `prefers-reduced-motion` pauses component animations.
- Deleting a board removes its rows and unreferenced media; its URL then shows the "does not exist" page; open tabs get `session_not_found`. Empty sessions older than 24 h are removed (integration test with a fake clock).
- Docs index, status table and setup guides match the shipped behaviour.

AGENT-12 (board preview PNG for agents) is not in these phases; see open question 7.

## 12. Open questions for the owner

1. Should agents get an "undo my last change" tool (server keeps per-agent change history), or is delete/update enough?
2. Do you want an opt-in server-side fetch of remote media (`MEDIA_FETCH=on`: https only, DNS resolved and every address checked against private ranges, redirects re-checked, size and time limits) so a link becomes an uploaded file with full support? This plan does not fetch, to avoid SSRF.
3. Default retention: keep boards forever (current plan) or delete boards not opened for N days?
4. Should look-only mode (VIEW-07) also exist as a separate read-only session link? That needs a second token per session and is not in this plan.
5. Are the limits right for your use: 25 MB per video, 200 MB per board, 5 GiB media and 1 GiB database per server, 10,000 boards?
6. Is the live-layer limit (components, web cards and remote media always above drawn items) acceptable for now, or should "band canvases" be added?
7. Do you want AGENT-12 (`get_preview`, a PNG of the board for agents, rendered on the server with `@resvg/resvg-js` from the SVG export) as a seventh phase?

## 13. Review answers (round 2)

| Finding | Fix | Where |
| --- | --- | --- |
| B1 echo loop | `finalizeScene` keeps identity and is scoped; local and remote paths split; dirty sets; convergence test with quiet check | §3.7 Rules A, B; §8; phases 1–3 |
| B2 data loss during interactions | by-id interactions; `SnapshotRegistry` rebases history, `before`, `textSession.before`; `del` only for removed ids; removal guard; unit and e2e tests | §3.7 Rules B, C; §8; phases 1, 3, 4 |
| B3 files in undo | files add-only in sessions; undo keeps current files; test | §3.7 Rule D; phase 2 |
| B4 remote media | remote GIF/video in the live layer without `crossOrigin`; canvas never tainted; eyedropper guard; uploads drawn on canvas | §6.2–6.4; phase 5 |
| B5 better-sqlite3 | exact pin 12.11.1; `db:smoke` at start-up and in tests; risk 5 | §3.2, §3.4, §3.5, §10 |
| B6 import origin | default `http://localhost:5183` (old dev origin), `PORT=5184` for old preview boards; e2e seeds the key on the served origin | §3.4, §4, §8 |
| B7 global caps and performance | `MAX_SESSIONS`, `MAX_TOTAL_MEDIA_BYTES`, `MAX_DB_BYTES` (507); live-item cap 24, videos only on screen with `preload="none"`; partial redraw and adaptive frame rate; perf e2e | §6.3, §7, §8; phase 5 |
| Minor: host check, body limits, stdio buffer | `hostHeaderValidation` app-wide; parsed 16 MB body; `maxBufferSize` 16 MiB; 10 MB tests | §5.1 |
| Minor: zod strips keys, flat schema | loose schemas, strict handler, flat element schema | §5.2 |
| Minor: atomic batches, keys | `atomic` mode; key rules for agents | §3.6, §3.9 |
| Minor: `layout` field, posters | `layout?: true` and `poster` op in the schema; concurrent corrections harmless | §3.6 |
| Minor: server text measuring | `fontkit` with bundled fonts | §3.8 |
| Minor: `npx`, shebang, cloud agents | `node …/dist-server/stdio.js`, `npm link`, shebang; tunnels for Devin and ChatGPT | §3.4, §9 |
| Minor: stateful MCP | stateless with `agent_name` | §3.9, §5.1 |
| Minor: no enumeration | `list: undefined`; nothing lists ids | §4 |
| Minor: rate limits in tests | configurable, `RATE_LIMITS=off` | §7 |
| Minor: synced mute | mute per tab | §6.1 |
| Minor: selection of live items | `TopOverlay` canvas above the live layer | §6.3 |
| Minor: URL rules, file ids | single-label and private suffixes refused; file ids checked per session | §6.2, §3.6 |
| Minor: phase 2 too large | split into phase 2 (one tab) and phase 3 (live sync) | §11 |
| Minor: dev CSP and upgrades | relaxed dev CSP; upgrades routed by path, HMR on `/__vite_hmr` | §3.4 |
| Minor: offline media | refused with a notice | §3.7 |
| Minor: board settings tool | `update_session` | §5.4 |
| Minor: server tsconfig, Vitest forks | `tsconfig.server.json` without DOM; `server` project with `pool: "forks"` | §3.3 |
