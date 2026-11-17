# Plan: board sessions, agent drawing (MCP) and media

Status: **planning round 3, waiting for owner review.** No application code has been written for this plan yet. Round 3 answers the review of round 2; the [review answers](#13-review-answers) at the end map each finding (rounds 2 and 3) to the section that fixes it.

Specs added with this plan: [06 — Sessions and agents](../features/06-sessions-and-agents.md) (SESS, AGENT) and [07 — Media](../features/07-media.md) (MEDIA). This plan explains how they are built; the specs say what "done" means.

## 1. Goal in one paragraph

Every board becomes a **board session** with its own address, `/s/<id>`. A small Node server in this repo stores sessions in SQLite, serves the app, keeps every open tab in sync in real time, and offers an **MCP server** so agents (Claude, Devin, ChatGPT, or any MCP client) can read and draw on a session when they know its id. Boards also get three new kinds of moving content: **animated GIFs**, **videos (MP4/WebM)** and **animated CSS components**. Users and agents can add, move, resize, rotate, group, layer, lock, undo and export all of them.

## 2. Where we start (current code)

- Front end only: React 19, strict TypeScript, Vite, Canvas 2D with roughjs and perfect-freehand.
- The scene is an ordered array `readonly SceneElement[]` plus a `FileMap` (`src/scene/types.ts`). Array order is the layer order. Elements are immutable objects; every change makes new objects.
- `Store` (`src/store/store.ts`) holds `AppState`. `commit()` records a history snapshot and runs `finalizeScene` on the **whole** scene; `updateElements()` does the same without history (drags, typing); `set()` replaces state as given. `onSceneChange` is the autosave hook. Undo/redo (`src/scene/history.ts`) stores whole snapshots `{elements, files}` and `undo()`/`redo()` restore both `elements` and `files`.
- `finalizeScene()` (`src/scene/scene.ts:276`) = `updateBindings(syncBoundTexts(elements))`.
  - `syncBoundTexts` (line 23) already keeps the same object when a label's box did not change, but it measures text (`src/scene/text.ts`: a canvas when there is a DOM, else `0.55 × font size` per character), so two browsers with different font state can compute different label sizes and container heights.
  - `updateBindings` (lines ~127–168) returns a **new object for every bound connector on every call** through `fromAbsolutePoints` (`src/scene/geometry.ts:112`), even when nothing moved. A bound end is placed with `sidePoint` (elbow routing, line 116) or `boundaryPoint` (line 98) of its target, and both depend on the **other** end too, so a connector is derived from both of its targets.
- `reorder()` (`src/scene/arrange.ts:86`) returns the **same element objects in a new order** (and `keepTextsWithContainers` moves each bound label right after its container). Undo/redo of a reorder also only changes array order. So any change detection by object reference misses layer changes (Rule E, §3.7).
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
| Layer order keys | `fractional-indexing` | String keys between neighbours, so a reorder changes one row. `generateKeyBetween(a, b)` throws unless `a < b`, so we only call it through `assignKeys` (§3.7 Rule E), which never passes equal or unordered neighbours. |
| Media metadata (server) | `image-size` (PNG, JPEG, GIF, WebP width/height), `mp4box` (MP4 width, height, duration) and a small EBML reader of our own for WebM (`server/media/webm.ts`, reads only `Segment/Info/Duration`, `TimecodeScale` and `Tracks/Video/PixelWidth/PixelHeight` from the first 256 KB) | If a file cannot be read, upload still succeeds with `width/height/duration_ms = null`; see §6.1 for the fallback. |
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
  media/             upload, type sniffing, metadata (image-size, mp4box, webm.ts), disk store, Range responses
  mcp/               buildMcpServer(service), tools/, input.ts (agent input -> elements),
                     compact.ts (elements -> agent view), prompts.ts, resources.ts, http.ts
  text/measure.ts    fontkit measuring for server-side layout
  stdio.ts           the stdio bridge (bundled with a `#!/usr/bin/env node` banner)
  security/          headers (CSP), host check, cross-site request guard (csrf.ts), limits,
                     rate limits, URL rules, id redaction
src/shared/          pure code used by both sides: protocol types, limits, ids, palette names,
                     component presets, URL rules, rebase helpers, layer keys (keys.ts: assignKeys)
src/sync/            SyncClient, RemoteLog (lazy rebasing), session routing, legacy import,
                     ServerFileStore, pending mirror
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
  | { t: "poster"; fileId: string; posterFileId: string }
  | { t: "fileMeta"; fileId: string; width: number; height: number; durationMs?: number };
```

- `layout: true` marks a **layout correction** (§3.8): it may only change derived fields (a text's `x`, `y`, `width`, `height`; a container's `height`) of an element whose `needs_layout` flag is set. The server checks that and clears the flag; the browser does not add the correction to its undo history. If several tabs correct the same element at once, the first one accepted clears the flag and later ones are acknowledged as no-ops (`ignored: "layout_done"`); either result is harmless.
- `poster` sets a file's poster once (§6.4); a second poster for the same file is a no-op.
- `fileMeta` fills a file's `width`/`height`/`durationMs` **only when the server could not read them** (all `null`, §6.1); otherwise it is a no-op. Like `poster`, it is not in undo history.
- **Versions and tombstones.** Every accepted op gets a server `version`, including `del` (the tombstone's version). `ack.versions` and the ops inside `changes` carry these versions for **both** `put` and `del`. The client keeps `confirmedVersion: Map<id, number>` for live **and deleted** ids for as long as the tab lives, and `snapshot` also lists `tombstones: {id, version}[]` (within the 30-day horizon), so a reloaded or resynced tab knows them too. A `put` always sends `baseVersion = confirmedVersion.get(id) ?? 0`. For a deleted id that is the tombstone's version, so the undo of a local delete and the clear notice's **Restore** pass rule 3 below; a `put` with `baseVersion` 0 on an id that has a tombstone is rejected.

Client → server:

| Message | Fields | Meaning |
| --- | --- | --- |
| `hello` | `clientId`, `sinceRev?` | First message. `sinceRev` asks for changes after that rev (reconnect). |
| `push` | `pushId`, `ops: Op[]` | A batch of changes (max 500 ops, max 2 MB). |
| `ping` | — | Keep-alive every 25 s. |

Server → client:

| Message | Fields | Meaning |
| --- | --- | --- |
| `snapshot` | `rev`, `elements: {el, idx, version, needsLayout}[]`, `tombstones: {id, version}[]`, `files: FileMeta[]`, `settings`, `title` | Full state, when `sinceRev` is missing or older than the tombstone horizon. |
| `changes` | `fromRev`, `rev`, `ops` (each `put` and `del` with its server `version`; `put`s with `needsLayout`), `files?`, `origin: {kind: "browser" \| "agent", name}` | Someone else's accepted batch. Never sent back to the socket that pushed it. |
| `ack` | `pushId`, `rev`, `versions: Record<id, number>` (for `put` and `del`), `rejected: {id, reason}[]`, `ignored: {id, reason}[]` | Result of my push. |
| `error` | `code`, `message` | For example `session_not_found`, `too_large`, `rate_limited`, `storage_full`. |

`SessionService.apply(sessionId, ops, {origin, atomic})` runs in one SQLite transaction:

1. Validate each element with `parseElement` plus the size limits (§7), check that `image`/`video` `fileId`s (and `posterFileId`s) exist in **this session's** `files` table (`unknown_file`), and check the session and global quotas.
2. `put` on a live element: accepted (last writer wins). `version` becomes `stored + 1`.
3. `put` on a **tombstone**: accepted only if `baseVersion` equals the tombstone's version (the client knew it was deleted, for example an undo of a delete). Otherwise rejected with `deleted`, so a late drag cannot bring back something another tab or an agent removed.
4. `del` writes a tombstone. Tombstones are kept 30 days; older ones are purged and clients asking for an older `sinceRev` get a `snapshot`.
5. **Modes.** `atomic: false` (browser pushes): invalid ops are rejected one by one and the rest are applied, so one bad element never blocks a user's other edits. `atomic: true` (every MCP tool call, REST `POST /ops?atomic=1`, legacy import): any rejection rolls the whole transaction back and the caller gets every reason at once.
6. The session `rev` increases by one per accepted batch. `changes` is broadcast to all other sockets of the session; the sender gets `ack`.

### 3.7 Browser side: local changes, remote changes, layer keys, undo and interactions

This section is the core of sync. Six rules together make sure that (a) the browser never sends changes it did not make, (b) every change it makes is sent, including layer order, (c) remote changes are never lost by a drag, cancel, undo or an unsent local edit, (d) derived fields (bound connector ends, label positions) are correct in every tab after concurrent edits, and (e) tabs reach the same scene and then go quiet.

**State kept by `SyncClient` (`src/sync/client.ts`), beside the Store's `elements`:**

| Name | Meaning |
| --- | --- |
| `keys: Map<id, string>` | the layer key (`idx`) of every live element. Not stored on `SceneElement`; `put` ops read it from here. |
| `confirmed: Map<id, {el?, version, idx?}>` | the last state the server confirmed for each id (`el` missing = tombstone). |
| `dirty: {put: Set<id>, del: Set<id>}` | local changes not yet sent (they wait for the next flush, up to 50 ms, longer while a push is in flight). |
| `pending: Map<pushId, Op[]>` and `pendingIds: Set<id>` | sent, not yet acknowledged. |
| `remoteLog` | changes the remote path applied to the visible scene (Rule C). |

`busy(id)` means `dirty.put ∪ dirty.del ∪ pendingIds` contains `id`.

**Rule A — `finalizeScene` keeps identity and is scoped (fixes the echo loop).**

- `updateBindings` returns the **same object** when the recomputed absolute points, `x`, `y`, `width`, `height` and `angle` are equal to the old ones (compare with `Math.abs(a - b) < 1e-6`), and keeps returning the same array when no element changed. `syncBoundTexts` already compares `x/y/width/height/angle`; it also must keep the container object when the needed height is not larger. Unit test: `finalizeScene(finalizeScene(s))` returns the same array object as `finalizeScene(s)`, for a scene with straight, curved and elbow connectors bound at both ends, connector labels and boxes with labels.
- `finalizeScene(elements, touched?)` gains an optional `touched: ReadonlySet<id>`. With it, only bound texts whose own id or container id is touched, and connectors whose own id or a bound end is touched (or removed), are recomputed. `Store.commit` and `Store.updateElements` pass `touched` = ids whose object differs from the current state, plus removed ids. Without `touched` (opening a file, import, tests) everything is recomputed as today. So a local action can only change the items it touched and their direct dependents.

**Rule B — local and remote changes take different paths (no pushes caused by remote changes, no lost unsent edits).**

- `Store.set()` / `commit()` / `updateElements()` / `undo()` / `redo()` are **local**. After each, the store hands `SyncClient` a `LocalChange { prev, next, hint? }` (the element arrays before and after, and an optional set of ids the action meant to re-layer, Rule E). `SyncClient` computes:
  1. `put` = ids whose object differs by reference, plus ids new in `next`; `del` = ids in `prev` that are gone from `next` and pass the removal guard below;
  2. `rekeyed` = ids whose key `assignKeys(prev, next, keys, hint)` changed (Rule E);
  3. adds `put ∪ rekeyed` to `dirty.put` and `del` to `dirty.del`.
  Because of Rules A, C and E this contains exactly what this tab's action changed, including pure layer changes.
- `Store.applyRemote(ops)` is **remote**. It is defined as
  `next = rebaseElements(currentLocalElements, ops.filter(op => !busy(op.id)), keys)`
  on the **current visible array**, not rebuilt from `confirmed` + `pending`. A remote `put` replaces the element where it is or inserts it at its key position; a remote `del` removes it. Ops for busy ids are **not applied to the scene** (the local edit is still on its way and will win or be rejected by the server); they only update `confirmed` (element, version, key). It does not touch history and does not report a `LocalChange`. Remote `put`s also update `keys`. After this, Rule F runs.
- A remote `del` for a busy id: the local copy stays and its `put` goes out with the old `baseVersion`, so the server rejects it with `deleted`; the reject handler then removes the item and shows the notice. This is the documented "a change to an item that someone else deleted is not kept".
- The only other outgoing ops that a remote change can cause are a **layout correction** for elements that arrive with `needsLayout` (§3.8), sent once per element version, and the bounded **derived-field repair** of Rule F. Neither can loop (see Rule F).
- **Flush:** at most one push per 50 ms during drags, at once after a commit, and at most one push in flight (the next waits for the ack). For each id in `dirty.put` that is in the current scene → `put` (current element, `keys.get(id)`, `baseVersion` from §3.6); for each id in `dirty.del` not in the scene → `del`. **An id that is simply missing from the array never becomes a `del`.** Flushed ids move from `dirty` to `pendingIds`.
- **Removal guard (defence in depth):** if a local change removes an id that the remote log shows was inserted or changed remotely after the snapshot the change was based on, the change is treated as stale: the element is put back, no `del` is sent, and a development warning is logged. Tests assert the guard never fires in normal flows (it exists to catch a code path that forgot Rule C).
- **Ack:** drop those ops from `pending` and `pendingIds` (unless the id was dirtied again), store server versions in `confirmed`. **Rejected ops:** drop them, restore the confirmed element (or remove it for a tombstone) through the remote path, and show a short notice ("Someone removed that item, so your change was not kept.").

**Rule C — everything that holds an old snapshot is rebased, lazily (fixes data loss during interactions).**

- **Remote log** (`src/sync/remoteLog.ts`): every change the remote path applies to the visible scene (remote ops that were not skipped, reject restores, Rule F does not count because it is local) gets the next local sequence number `seq`. The log keeps **only the latest entry per id**: `Map<id, {seq, el | null, idx}>`. Because ops replace whole elements (last writer wins per element), applying only the latest change per id gives the same result as replaying every op. So the log never holds more entries than ids that ever changed remotely, however long another tab drags.
- Anything that keeps an elements array for later stores the `seq` it was taken at: history undo/redo entries, every controller interaction's `before`, `textSession.before`, and the clear notice's "Restore" buffer (§3.9). Nothing is rebased when a remote batch arrives. A snapshot is rebased **only when it is used** (undo, redo, cancel, Esc, `commitFrom(before)`, Restore): `rebaseElements(snapshot, remoteLog.since(snapshot.seq), keys)`, then its `seq` becomes the current one.
- **Shared instances:** the log stores the **same element object** that `applyRemote` put into the visible scene, and `rebaseElements` inserts that object as is. So after an undo, a remotely changed element in the rebased snapshot is `===` the one on screen, and Rule B's reference diff does not produce a redundant `put` for it.
- **Interactions work by id against the current state.** `move`, `resize` and `rotate` stop keeping the whole array as `base`. They keep `base: Map<id, SceneElement>` with only the items being changed (the selection plus dependents from `withDependents`). Each pointer move maps over the **current** `store.get().elements` and replaces only those ids, so items added or changed by others during a drag stay. If a remote `del` removes an item that is being dragged, the controller drops it from `base` and `ids` on the next frame, so the drag does not bring it back. A remote `put` to an item being dragged does not reach the scene (the item is busy, Rule B); the drag's write wins (last writer wins, documented).
- `cancel()` and the restores at controller lines ~577, ~785, ~1046, ~1060 keep using `it.before.elements`, which is rebased at that moment, so Esc after a drag keeps remote changes. `commitFrom(before)` records the rebased snapshot.
- **Undo is personal.** Because snapshots are rebased before use, undo and redo only revert this tab's own steps; agent and other-tab changes stay. One documented edge case: if someone else changed an item after this tab created it, undoing the creation keeps their version. History length stays 200. Cost: one rebase is `O(n + log entries since seq)` and runs only on undo/redo/cancel; a unit test checks a 5,000-element board with 2,000 log entries rebases one snapshot in under 10 ms, and a remote batch of 200 ops is applied in under 20 ms however many snapshots exist.

**Rule D — files are add-only in a session (fixes files lost by undo).**

- In a session, `files` only grows: `applyRemote` merges new file entries, and `Store.undo()`/`redo()` keep the **current** `files` map instead of restoring `prev.files` (in local-only mode, used by unit tests and `.chalana` preview, they behave as today). Unused file entries are harmless; the server cleans files of deleted sessions only. Test: an agent adds a picture and a video, the user undoes an earlier step, the picture and video still show.

**Rule E — layer keys live beside the elements and are kept strictly increasing (fixes unsynced reorders).**

- `src/shared/keys.ts` exports `assignKeys(prev, next, keys, hint?) → Set<id>` used by the browser, the server's agent path (§3.9) and legacy import. Both sides order the scene by `(idx, id)` (the server with `ORDER BY idx, id`, the browser when it inserts by key), so equal keys from two writers still give the same order everywhere.
- Algorithm, on the new array order `next`:
  1. **Fast path:** if `next` has the same ids in the same order as `prev` (one O(n) pass) and every id has a key, nothing changes. This is the case for every drag frame.
  2. Otherwise find the largest set of elements whose existing keys are **strictly increasing** in `next` order (longest increasing subsequence, `O(n log n)`). Ties between equally long choices keep elements **not** in `hint` (so the items the user moved are the ones that get new keys), then keep the lower id. Because the order must be strictly increasing, a run of **equal keys** can keep at most one member; the others are re-keyed.
  3. Every other element (moved, new, or in a duplicate run) gets a new key from `generateKeyBetween(left, right)` / `generateNKeysBetween` where `left` and `right` are the nearest kept or already-assigned keys around it; both are distinct and ordered by construction, so the library never throws. If a key would exceed 64 characters (after very many inserts in one gap), the whole run between the two nearest short keys is re-spread.
  4. Return the ids whose key changed; they are added to `dirty.put`.
- `assignKeys` runs **only on local changes** (and on agent changes on the server), never on remote ones, so duplicate keys that arrive from two concurrent writers are repaired by whichever writer next edits around them, not by every tab at once. Until then the `(idx, id)` order keeps all replicas identical.
- `hint`: `Store.commit` takes an optional `{reorder: ids}` from the arrange actions (front/back/forward/backward) and records it in the history entry, so undo and redo of a reorder pass the same `hint` and push the same ids. Bound labels moved by `keepTextsWithContainers` with their container are added to the hint.
- Example: "bring to front" of box X with label L changes the keys of X and L only (two `put`s); its undo also changes only X and L.

**Rule F — derived fields are repaired after remote changes (fixes stale bindings).**

Problem: tab A drags box X with connector C (C is busy in A). Meanwhile an agent moves box Y, the other end of C, and the server finalises C against the old X. Then A's `put` of C (new X, old Y) wins by last-writer-wins, and every replica would keep a C detached from Y. The same can happen to a bound label whose container changes remotely while the label is busy locally.

Fix, in the browser right after `applyRemote` (the server is not changed for this):

1. Run `finalizeScene(next, touched = ids of the applied and the skipped remote ops)`. This recomputes only connectors and labels that depend on those ids (Rule A).
2. Accept a recomputed element only when it is **busy** (its local version is going to overwrite the server's anyway), or when it is the **container of a busy label** and only its derived height changed. Discard every other recomputed result (a non-busy dependent came from its writer already finalised).
3. Accepted results are written to the scene and added to `dirty.put`, so they are pushed with the next flush.

Why it cannot loop: a repair only happens for elements that are already busy, so it never adds a new id to the outgoing set except a container's height; after the ack, the element is no longer busy and later remote echoes of the same values recompute to identical objects (Rule A), which are discarded. The quiet check in the convergence test covers this.

**Reconnect and offline.** Exponential back-off (0.5 s to 10 s). Send `hello` with the last `rev`; resend `pending` and then `dirty`. While offline, the status chip says "Offline — your changes will be sent when the connection is back". **Pending mirror (from phase 2):** after every local change, `dirty` and `pending` ops (element JSON, key, base version) are written synchronously to `localStorage["chalanamaya.pending.<id>"]` and removed when acknowledged; on load the app first loads the server scene, then lays the mirrored ops on top as local dirty changes and pushes them. On `pagehide` the client also flushes with `fetch(POST /ops, {keepalive: true})` when the body is under 60 KB (the browser's keepalive quota is 64 KB); larger leftovers are sent from the mirror on the next load. **Pictures and media need the server:** while offline, inserting a picture, GIF or video is refused with the notice "Pictures and media can be added when you are back online"; items already on the board keep working.

**Convergence test** (`src/sync/convergence.test.ts`, unit, no browser): two `Store` + `SyncClient` pairs and a scripted "agent" talk to a real `SessionService` (in-memory SQLite) through an in-process transport whose delivery order is driven by a seeded random scheduler (100 seeds). Each tab uses a different text measurer (to simulate different font states). Script: tab 1 drags box X, which has a connector C to box Y and a label, while the agent moves Y, adds 20 items and edits 5; tab 2 edits a connector label, changes styles and sends one item to the back; tab 1 cancels a second drag with Esc, brings an item forward and undoes twice. After all messages are delivered:

- both tab scenes and the server scene are equal (same ids, same `(idx, id)` order, same keys, same element JSON);
- **binding invariants hold in every replica:** each bound connector end equals `boundaryPoint`/`sidePoint` of its target (computed as `updateBindings` does) within 1e-6, and each bound label is centred in its container within 1e-6 and fits its height;
- **for the next 20 simulated seconds no tab sends a push.**

A second test checks that the agent's 20 items exist after the drag, the cancel and both undos. Focused unit tests: (1) a remote batch arriving **between a local edit and its flush** keeps the local edit and applies the rest; (2) the X/C/Y scenario above, in both delivery orders, ends with C attached to both boxes; (3) a label being typed while its container is resized remotely ends centred.

### 3.8 Text measured on the server

When the server creates or changes text for agents, `server/text/measure.ts` measures with `fontkit` using the same `.woff` files the app bundles (`@fontsource/kalam`, `source-sans-3`, `ibm-plex-mono`, latin subsets), installed with `setMeasure` in the server. Widths should match the browser to within a few percent, so agents get realistic sizes back. Because browsers can still differ slightly (hinting, fallback fonts), the server sets `needs_layout = 1` on text it laid out. The first browser that receives such an element, with fonts loaded, runs `finalizeScene` on just that element and its container (`touched`) and sends one `put` with `layout: true` (§3.6). If its result equals the server's, it sends a `layout: true` put with unchanged geometry only to clear the flag.

### 3.9 How the browser and agents share one scene

- Agents never touch raw rows. MCP tools call `SessionService.applyAgentChange(sessionId, mutate, {agentName})`, where `mutate` receives the current element array and returns a new one plus the set of ids it touched, using the same pure functions the UI uses (`createShape`, `groupElements`, `reorder`, `alignElements`, `deleteElements`…). The service then runs **`finalizeScene(next, touched)` with only the agent-touched ids, never a full finalize**: a full pass with the server's fontkit measurer would re-lay-out every browser-measured label and container in the board (the fonts render slightly differently), and push spurious changes for the whole board. It diffs before/after by reference into ops, runs `assignKeys(before, after, keys, hint)` (Rule E) and adds re-keyed ids, and applies the ops with `atomic: true` and `origin = {kind: "agent", name}`. So bindings, bound labels and frames behave exactly as when a person draws.
- **Layer keys for agent items** come from the same `assignKeys` (Rule E): new items are appended after the current top key in call order; a bound label sits right after its container; `reorder_elements` passes its ids as `hint`, so only the moved items (and their labels) get new keys. A browser tab and an agent that append at the same moment may produce the same key; both sides order by `(idx, id)` and the next local change around them re-keys the run (Rule E), so nothing breaks.
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
  - Every state-changing route (`POST`, `PUT`, `DELETE` under `/api`) requires the header `X-ChalanaMaya: 1` and passes the Origin checks of §7 (cross-site request guard); otherwise `403 cross_site_refused`. The app's own fetch wrapper always sends the header.
  - `POST /api/sessions` `{title?}` → `201 {session_id, url}`; `429 rate_limited`; `507 too_many_sessions`
  - `GET /api/sessions/:id` → `{session_id, title, rev, element_count, created_at, updated_at}`
  - `GET /api/sessions/:id/scene` → `{rev, elements, files, settings}` (full, used by tests, import and export)
  - `POST /api/sessions/:id/ops[?atomic=1]` `{ops}` → same result as a socket `ack` (phase 2 single-tab saving, tools, tests)
  - `POST /api/sessions/:id/files` (raw body, `Content-Type` = media type) → `{file_id, url, mime, size, width, height, duration_ms}` (each `null` when unreadable, §6.1); `413 too_large`; `415 unsupported_type`; `507 storage_full`
  - `GET /api/sessions/:id/files/:fileId` → bytes, supports `Range`
  - `DELETE /api/sessions/:id` → `204`
  - `GET /api/health` → `{ok: true, version}`

## 5. MCP server

### 5.1 Endpoints

- **Streamable HTTP:** `POST /mcp` on the app server, stateless (§3.9). `GET`/`DELETE /mcp` answer `405` (no server-sent streams are needed in stateless mode).
- **Body size — one mechanism:** `express.json({limit: "16mb"})` on `/mcp` parses the body and the parsed body is passed to `transport.handleRequest(req, res, req.body)`. With a `parsedBody` the SDK skips its own reader (and its 4 MB `maxRequestBodySize` default), so the express limit is the only one; a 10 MB base64 `upload_media` (≈13.4 MB of JSON) fits and a body over 16 MB gets `413` with a JSON-RPC error body from our error handler. We do not also set the transport's `maxRequestBodySize`, so there is one limit to document and test.
- **Host check for the whole app:** the SDK's `hostHeaderValidation(allowedHosts)` middleware runs before every route (app, REST, `/mcp`), and the WebSocket `upgrade` handler checks the same list. The middleware compares **hostnames without ports** (`new URL('http://' + host).hostname`), so the list holds bare hostnames: `localhost`, `127.0.0.1`, `[::1]` (the bracketed form, which is what `URL.hostname` returns for IPv6), plus the hostname of `PUBLIC_URL` when set (tunnels), plus a comma-separated `ALLOWED_HOSTS` env var for LAN use with `HOST=0.0.0.0` (for example `ALLOWED_HOSTS=192.168.1.20,myboard.lan`). The deprecated `allowedHosts`/`enableDnsRebindingProtection` transport options are not used. `/mcp` also goes through the Origin check of §7.
- **stdio:** `node dist-server/stdio.js` (or `npm run mcp:stdio`, or `chalanamaya-mcp` after `npm link`), env `CHALANAMAYA_URL` (default `http://localhost:5183`). It is a **pure proxy built on the low-level `Server` class** (not `McpServer`, whose `registerTool` needs local zod schemas): on start it connects an SDK `Client` to `${CHALANAMAYA_URL}/mcp`, copies the remote `capabilities`, and registers `server.setRequestHandler` for `ListToolsRequestSchema`, `CallToolRequestSchema`, `ListPromptsRequestSchema`, `GetPromptRequestSchema`, `ListResourcesRequestSchema`, `ListResourceTemplatesRequestSchema` and `ReadResourceRequestSchema`. Each handler forwards with `client.request({method, params}, <matching result schema>)` and returns the result **raw**; it does not use `client.callTool`, which validates `structuredContent` against the cached `outputSchema` and could turn a valid server answer into a client-side error. For `tools/call` of write tools without `agent_name`, it fills `agent_name` from `server.getClientVersion()?.name` (the desktop client's `clientInfo`). The transport is `new StdioServerTransport()` with a 16 MiB read buffer (`maxBufferSize`; the SDK default `STDIO_DEFAULT_MAX_BUFFER_SIZE` is 10 MB, smaller than a 10 MB upload in base64). When the server cannot be reached, every call returns `isError` with "ChalanaMaya is not running at <url>. Start it with `npm start`."

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
| `get_scene` | `format?: "json" \| "outline"` (default json), `ids?`, `region?: {x,y,width,height}`, `query?` (text search), `limit?` (≤ 500, default 200), `cursor?` | `{rev, bounds, count, elements: CompactElement[], next_cursor?, free_space: {x, y}}` or `{rev, outline: string, next_cursor?}` |
| `add_elements` | `elements: ElementInput[]` (1–200) | `{rev, created: [{key?, id, type, x, y, width, height}], warnings: string[]}` |
| `update_elements` | `updates: ({id} & Partial<ElementInput without type>)[]` (1–200) — text, label, name, url, points, from/to, geometry, style, locked, link, media settings | `{rev, updated: string[], warnings}` |
| `move_elements` | `ids`, either `dx`/`dy` or `to: {x, y}` (new top-left of the group's box) | `{rev, moved: string[], bounds}` |
| `set_style` | `ids`, `style: StyleInput` | `{rev, updated: string[], skipped: [{id, reason}]}` (e.g. fill on a text) |
| `delete_elements` | `ids` (labels go with their shape; connectors to deleted items are unbound) | `{rev, deleted: string[]}` |
| `group_elements` / `ungroup_elements` | `ids` | `{rev, group_id?}` |
| `reorder_elements` | `ids`, `to: "front" \| "back" \| "forward" \| "backward"` | `{rev}` |
| `arrange_elements` | `ids` (≥ 2), `align?: "left" \| "center" \| "right" \| "top" \| "middle" \| "bottom"`, `distribute?: "horizontal" \| "vertical"`, `gap?` | `{rev, bounds}` |
| `clear_scene` | `confirm: true` (required) | `{rev, deleted_count}` |
| `upload_media` | `data_base64`, `mime_type`, `filename?` (≤ 10 MB decoded for pictures/GIFs, ≤ 25 MB for videos up to the 16 MB request cap, see §7) | `{file_id, mime_type, size, width, height, duration_ms}` (`null` when the server could not read them, §6.1) |
| `place_media` | `kind: "image" \| "gif" \| "video"`, `source: {file_id} \| {url} \| {data_base64, mime_type}`, `x?`, `y?`, `width?`, `height?`, `autoplay?`, `loop?` | `{rev, id, file_id, warnings}` (a `{url}` source, for **any** kind including static pictures, warns that remote media is shown in the live layer and exported as a placeholder, §6.2) |
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

**Paging semantics.** Items are returned in `(idx, id)` order after filtering. `next_cursor` is an opaque base64url string encoding `{rev, after: [idx, id], filter_hash}`. A call with a cursor is answered only if the session's `rev` still equals the cursor's `rev` and the filters are the same; then it returns the items after `(idx, id)`, so pages are a consistent view of one revision with no gaps or duplicates. If the board changed in between, the call fails with `isError` and code `stale_cursor`: "The board changed while you were paging (rev 41 → 43). Call get_scene again without a cursor, or narrow it with ids, region or query." Agents are told in the skill to prefer filters, `format: "outline"` and `limit: 500` on busy boards. (The server is stateless per request, so it does not keep snapshots for paging.)

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

**Media metadata and default size.** On upload the server reads width and height with `image-size` (PNG, JPEG, GIF, WebP), and width, height and duration with `mp4box` (MP4) or `server/media/webm.ts` (WebM) (§3.2). Placing media without a size uses 480 px width and the file's aspect ratio. If the server could not read the metadata (unusual encoders, remote links), the item is placed at **480 × 270 (16:9)** and the media is drawn with "contain" fitting (letterboxed, never stretched). For an uploaded file with unknown metadata, the first browser that loads it sends one `fileMeta` op (§3.6) with `naturalWidth/naturalHeight` or `videoWidth/videoHeight/duration`, so later placements and `get_scene` know the real size; the existing item keeps its size (the user can resize it, Shift keeps the shape).

All new elements reuse `BaseElement`, so move, resize (keep aspect with Shift for media, like pictures), rotate, select, group, layer order, lock, frames, links, undo/redo and sync work without special cases. `parseElement`, `hit.ts`, `geometry.ts`, `transform.ts`, `svg.ts`, `renderScene.ts`, the properties panel and the compact agent view each get the new types.

### 6.2 Two kinds of media source

| | **Uploaded** (`source: "upload"`, same origin `/api/sessions/:id/files/…`) | **Remote link** (`source: "remote"`, an https URL) |
| --- | --- | --- |
| Applies to | pictures, GIFs, videos uploaded to this session | **every** linked picture (PNG/JPEG/WebP/GIF from `place_media kind: "image"` or `add_elements type: "image"` with `url`), GIF and video |
| Who loads the bytes | the browser, same origin | the browser, directly from the other site (the **server never fetches** remote URLs, so no server-side request forgery), with `referrerpolicy="no-referrer"` on the `<img>`/`<video>` |
| Where it is drawn | on the **board canvas**, in layer order | in the **HTML live layer** (like web cards), with a canvas placeholder underneath |
| GIF animation | yes (bytes fetched same-origin, decoded, §6.3) | yes, as a plain animated `<img>` |
| Video | `<video>` without `crossOrigin` (not needed for same origin) | `<video>` **without `crossOrigin`**, so sites without CORS headers still play |
| Layer order | exact | above drawn items (the documented live-layer limit, risk 1) |
| PNG export | first frame / poster | placeholder card with the host name (§6.4); `exportToCanvas`/`loadImages` (`src/io/export.ts:40`) skip remote files, so the export canvas is never tainted and `toBlob` cannot throw |

Remote static pictures follow exactly the same rules as remote GIFs and videos: they are **never drawn on the board canvas** (only a placeholder card under the live `<img>`), they show as a placeholder in PNG export and the overview, and they use the live-layer slot cap. Pictures that users paste or drop are always uploaded, so only agents (or a pasted link in **Insert media…**) create remote pictures.

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
- **Live layer** (today's `WebCards` layer, renamed `LiveLayer`): web cards, CSS components and remote pictures, GIFs and videos.
  - **Cap:** at most **24 live items mounted** at once. Candidates are on-screen live items, ranked: the active web card, selected items, then larger on-screen area. Items beyond the cap, items smaller than 48 screen pixels, and everything when zoom is below 30 % are drawn as their static fallback on the canvas (§6.4) instead of being mounted.
  - **Selection above live items:** the overlay (selection frames, handles, snap lines, the lasso) moves from the scene canvas to a new `TopOverlay` canvas stacked **above** the live layer with `pointer-events: none`, so selected live items show their frame and handles. Scene canvas → live layer → top overlay → UI.
  - Within the live layer, items follow board layer order, but the layer sits above the canvas (risk 1).
- **CSS components:** each is an `<iframe sandbox="" srcdoc="…" referrerpolicy="no-referrer" loading="lazy">` — **no `allow-scripts`, no `allow-same-origin`**, so it is a unique origin that can run no script, open no popups and submit no forms. `pointer-events: none` always (components are look-only), so the board handles selection and dragging. Paused components get `animation-play-state: paused` injected.
- **Component content:**
  - Presets (built-in templates from `src/shared/presets.ts`; parameters are typed and validated, no free text goes into CSS): `pulse` (dot with colour), `spinner` (colour, speed), `typing-dots`, `progress-bar` (value 0–100, colour, label), `shimmer-card` (lines), `marquee` (text, speed), `bounce-arrow` (direction, colour), `gradient-wave` (two palette colours). Text parameters are HTML-escaped.
  - Custom: `html` ≤ 20 KB and `css` ≤ 20 KB. The server checks sizes and rejects obvious bad content with clear messages (`<script`, `on*=` attributes, `javascript:`, `@import`, `url(` other than `data:image/png|jpeg|gif|webp`, `<iframe`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`, `<form>`, `<style>` inside `html`). Three layers: server check, sanitiser, sandbox without scripts.
  - **Building the `srcdoc` (`src/media/componentDoc.ts`).** The document is a **fixed shell** written by our code; user content never forms the document structure, and the whole document is never passed through DOMPurify (that would strip the CSP `<meta>`):
    ```html
    <!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
    <meta charset="utf-8">
    <style>/* base reset + paused rule */</style>
    <style>/* user CSS after the CSS filter */</style>
    </head><body>/* user HTML after DOMPurify */</body></html>
    ```
    The CSP `<meta>` is the first element in `<head>`. The **body fragment** is cleaned with `DOMPurify.sanitize(html, {ALLOWED_TAGS: […layout and text tags, inline svg shapes…], ALLOWED_ATTR: ['class','id','style','role','aria-*', …svg presentation attrs], FORBID_TAGS: ['style','link','meta','base','script','iframe','object','embed','form','foreignObject'], ALLOW_DATA_ATTR: false})`, with `href`/`src` allowed only for `data:image/(png|jpeg|gif|webp)`. **CSS is handled only by the CSS filter** (`src/shared/cssFilter.ts`): it tokenises, drops `@import`, `@font-face` with non-`data:` sources, `@namespace`, `expression(`, `behavior:`, `-moz-binding`, any `url(` that is not an allowed `data:` image, and escapes `</` so the text cannot close the `<style>` element. Inline `style` attributes kept by DOMPurify go through the same filter (DOMPurify `uponSanitizeAttribute` hook).

### 6.4 Export and file fallbacks

| Item | PNG export / copy as PNG / board overview | SVG export | `.chalana` file |
| --- | --- | --- | --- |
| Uploaded GIF | first frame | `<image href="data:image/gif…">` (browsers animate GIFs inside SVG) | inlined file |
| Uploaded video | poster frame + small play badge; placeholder card ("Video · name") if no poster | poster `<image>` + play badge | inlined file under 50 MB total, otherwise kept as a link with a warning |
| Remote picture, GIF or video | placeholder card with the host name (and a play badge for GIF/video); never drawn from the remote pixels | placeholder card wrapped in `<a href>` to the URL | link only |
| Component | static card: title and "Animated component" (presets draw a simple still picture) | same static card as SVG shapes | the element data (HTML/CSS) |

Posters: when a browser first plays an uploaded video that has no poster, it captures a frame at 0.1 s, uploads it as a PNG and sends a `poster` op (§3.6; not in history). Remote videos have no poster; the placeholder is used.

## 7. Security limits

- **Access model:** no accounts in this round. The **session id is the access token**: anyone (person or agent) who has it can read and change the board. 144 random bits; never logged in full (logs show the first 4 characters); never listed (§4); `Referrer-Policy: strict-origin-when-cross-origin` so other sites see only the origin, never `/s/<id>`; the "Connect an agent" dialog and docs say "treat the link like a password". Documented in `docs/security.md` and in SESS-08.
- **Binding:** listens on loopback (127.0.0.1 and ::1) by default. Exposing it (`HOST=0.0.0.0`, or a tunnel for Devin and ChatGPT) is an explicit choice; docs recommend HTTPS in front and setting `PUBLIC_URL`.
- **Host check:** SDK `hostHeaderValidation` on every route and on socket upgrades, with bare hostnames plus `PUBLIC_URL` and `ALLOWED_HOSTS` (§5.1). This stops DNS rebinding, but **not** cross-site requests: a page on another site that sends `fetch('http://localhost:5183/api/sessions', {method: 'POST', mode: 'no-cors', body: 'x'})` or submits an HTML form still carries `Host: localhost:5183`.
- **Cross-site request guard (`server/security/csrf.ts`)**, on every state-changing REST route (`POST`/`PUT`/`DELETE` under `/api`), on `POST /mcp` and on socket upgrades:
  1. If `Sec-Fetch-Site` is `cross-site` → `403 cross_site_refused`. (`same-site` is not enough, because `http://localhost:5000` is same-site with `localhost:5183`; rule 2 covers it.)
  2. If an `Origin` header is present, it must be in the **allowed origins**: `http://localhost:<PORT>`, `http://127.0.0.1:<PORT>`, `http://[::1]:<PORT>`, the origin of `PUBLIC_URL`, and each `ALLOWED_HOSTS` entry with the port; otherwise `403`. Requests with no `Origin` (curl, MCP clients, the stdio bridge) pass this rule.
  3. REST only: the request must carry `X-ChalanaMaya: 1`. A custom header makes any cross-origin browser request "non-simple", so the browser sends a CORS preflight first; the server serves **no CORS headers**, so the preflight fails and the real request is never sent. HTML forms cannot set headers at all. (File uploads keep their media `Content-Type`, which is why the rule uses a custom header rather than `Content-Type: application/json`.) `/mcp` already forces a preflight because the SDK requires `Content-Type: application/json` and an `Accept` header with `application/json` and `text/event-stream`; rules 1 and 2 still apply to it.
  Result: a tab left open on a malicious page cannot create sessions (and so cannot fill `MAX_SESSIONS`), write ops, upload, or delete boards. Integration tests: a `text/plain` POST with `Origin: https://evil.example` → 403 and no session created; the same without `X-ChalanaMaya` and without `Origin` → 403; `Sec-Fetch-Site: cross-site` → 403; `/mcp` with a foreign `Origin` → 403; the app's own requests pass.
- **Input validation:** zod for every REST body and socket message; strict handler validation for MCP input (§5.2); `parseElement` for every stored element; ids checked by format; file references checked against the session's own files.
- **Per-session caps (defaults, all configurable):** 5,000 live elements; 64 KB per element JSON; 10 MB per session scene JSON; 10,000 characters per text; 5,000 points per pencil path; 500 ops / 2 MB per socket message; 2 MB REST JSON; 16 MB MCP JSON; 200 elements per MCP call; pictures and GIFs 10 MB, videos 25 MB per file (MCP base64 uploads are capped by the 16 MB request, about 11.9 MB of bytes; larger videos are uploaded from the UI); 200 MB media per session; 50 sockets per session.
- **Global caps (new, defaults, configurable):** `MAX_SESSIONS = 10000` → `507 too_many_sessions` (REST) / MCP error; `MAX_TOTAL_MEDIA_BYTES = 5 GiB` (sum of `blobs.size`) → `507 storage_full`; `MAX_DB_BYTES = 1 GiB` (`page_count × page_size`, checked before each write batch) → `507 storage_full` and socket `error {code: "storage_full"}`. The browser shows "The ChalanaMaya server is full. Ask its owner to free space." Reads keep working. Integration tests run with tiny limits.
- **Media checks:** allowed types `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `video/mp4`, `video/webm`; the first bytes must match the claimed type (magic numbers); no SVG uploads. Served with the sniffed type, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, max-age=31536000, immutable`.
- **No server-side fetching** of remote media (no SSRF), for pictures, GIFs and videos alike. Remote URL rules in §6.2; remote items are loaded with `referrerpolicy="no-referrer"`.
- **Rate limits** (`express-rate-limit`, per IP, configurable with `RATE_LIMITS=off` or per-limit env vars): 30 new sessions per minute, 60 uploads per minute, 600 MCP requests per minute; socket pushes limited to 50 per second per connection. Playwright and integration tests run with `RATE_LIMITS=off`, except the test that checks the limits.
- **Headers for the app (production):** CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.figma.com https://codepen.io; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`. (`srcdoc` frames inherit this policy and add their own stricter one.) Dev mode relaxes `script-src` and `connect-src` for Vite (§3.4).
- **No secrets in the repo:** config only from environment; `.env` files ignored; tests use temp data folders.
- **Components:** see §6.3 (no script execution, three layers).

## 8. Testing strategy

**Unit (Vitest `app` project, Node):**
- ids: length, alphabet, entropy source; session URL parsing (`session_id` as id or URL).
- `finalizeScene` identity: `finalizeScene(finalizeScene(s)) === finalizeScene(s)` for straight, curved and elbow connectors and labels; scoped `touched` recomputes only dependents.
- Store `LocalChange` diff: a move reports only moved items and their connectors; `applyRemote` reports nothing.
- **Layer keys (`src/shared/keys.test.ts`, `src/sync/client.test.ts`):** front, back, forward and backward each push **only the moved ids plus their bound labels**; the undo and the redo of each reorder push the same ids (hint stored in history); a fast-path drag frame re-keys nothing; inserting between two neighbours whose keys are equal (duplicate keys, as produced by two concurrent appends) does not throw and re-keys only the run; a scene with three equal keys then a "forward" gives strictly increasing keys; ordering by `(idx, id)` is identical on client and server; keys longer than 64 characters trigger a re-spread; property test: 10,000 random reorder/insert/delete steps keep keys strictly increasing and never throw.
- **Remote path (`src/sync/client.test.ts`):** a remote batch that arrives **between a local edit and its flush** keeps the local edit (dirty ids skipped) and applies the other ops; a remote batch during an in-flight push keeps the pending edit; a remote `del` of a busy id leads to the `deleted` reject, removal and notice; tombstone versions from `ack` and `changes` are used as `baseVersion` for undo of a delete and for Restore; Rule F repairs a busy connector after a remote move of its other end and repairs a busy label after a remote container resize, and never repairs a non-busy element.
- `rebaseElements` and the remote log: put/insert at key/delete; latest-entry-per-id gives the same result as replaying all ops (property test); lazy rebase on undo/cancel/commitFrom; a remotely changed element in a rebased snapshot is `===` the one on screen (no redundant put after undo); performance: 5,000 elements + 2,000 log entries rebase < 10 ms, a 200-op remote batch < 20 ms regardless of history depth; files kept on undo/redo in session mode.
- Controller by-id interactions: while a move, resize, rotate, text edit and freedraw are in progress, remote puts/dels arrive; after pointer moves, Esc, commit, undo and redo, every remote item is still there and no `del` is produced for it.
- Convergence test (§3.7) with two tabs, an agent, different text measurers and 100 seeded delivery orders: equal scenes and keys, **binding invariants** (bound ends on `boundaryPoint`/`sidePoint` of their targets within 1e-6, labels centred), quiet after convergence.
- Agent input → elements: every type, defaults, palette names, degrees → radians, `key`/`from`/`to` resolution, atomic failure, unknown-field warnings, error messages (snapshot of messages).
- Compact view and outline: default fields omitted, labels folded, order, paging, size cap.
- Media: magic-number sniffing, remote URL rules (including single-label and `.internal` hosts), GIF pixel budget, frame-budget state machine (fake clock), live-layer cap ranking, eyedropper `SecurityError` fallback.
- Components: sanitiser with a corpus of attacks (script tags, `onerror`, `javascript:` URLs, `@import`, external `url()`, `<meta refresh>`, SVG `<foreignObject>` and `<a>`, CSS `expression`); preset parameter validation and escaping.
- Esc fix: controller/App logic for leaving an active card.

**Server and integration (Vitest `server` project, `pool: "forks"`, real server on a random port 5000–5999 with a temp `DATA_DIR`):**
- `db:smoke` and `SessionService` with in-memory SQLite: modes `atomic` on and off, tombstone rule, layout correction rule, poster op, `unknown_file`, quotas (session, global media, DB size) with tiny limits.
- REST: create, read, ops, files (upload, Range, wrong type, too big, metadata from `image-size`/`mp4box`/WebM reader, `null` metadata for an unreadable file), delete, 404s, size limits, rate limits (one test with limits on), host header refused (with and without a port; `[::1]:5xxx` accepted; an `ALLOWED_HOSTS` entry accepted).
- **Cross-site guard:** a `text/plain` `POST /api/sessions` with `Origin: https://evil.example` → 403 and the session count is unchanged; a POST without `X-ChalanaMaya` → 403; `Sec-Fetch-Site: cross-site` → 403; `DELETE` and `POST /ops` with a foreign Origin → 403; `POST /mcp` with a foreign Origin → 403; a socket upgrade with a foreign Origin is refused; the same requests from the allowed origin succeed.
- Server agent path: `applyAgentChange` with `finalizeScene(next, touched)` leaves every untouched element (including browser-measured labels) byte-identical; a reorder through MCP changes the keys of the moved ids only.
- Sockets: two `ws` clients converge; reconnect with `sinceRev`; old `sinceRev` gets a snapshot; tombstone rejection; message too large; the sender does not receive its own `changes`.
- MCP over HTTP with the SDK `Client` + `StreamableHTTPClientTransport`: `listTools` matches the documented list (test fails if `docs/agents/mcp-tools.md` misses a tool); every tool's happy path and main errors; unknown fields give warnings; prompts and resources list and read; `resources/list` contains no session ids; a 10 MB `upload_media`; a `/mcp` body over 16 MB → 413; `get_scene` paging returns every item once on a quiet board and `stale_cursor` after an edit between pages; an MCP change reaches a socket client as `changes` with `origin.kind = "agent"` and the given `agent_name`; a socket change is seen by `get_scene`; a fresh client works after a server restart (stateless).
- MCP over stdio with `StdioClientTransport` spawning the built `dist-server/stdio.js` against the running server: smoke set plus a 10 MB `upload_media`; a tool result with `structuredContent` arrives unchanged (raw forwarding); a write without `agent_name` is attributed to the test client's `clientInfo.name`; unreachable server gives the clear error.

**End to end (Playwright, Chromium, built server on port 5184, `RATE_LIMITS=off`):**
- All existing specs keep running. `e2e/helpers.ts` changes once: `freshBoard` opens `/` (new session each test) and `storedElements` reads `GET /api/sessions/<id>/scene`, polling until the client is idle. Specs that read localStorage directly (`p1.spec.ts`, `revision.spec.ts`, theme in `smoke.spec.ts`) switch to the same helper; preference checks keep reading `chalanamaya.prefs`.
- `sessions.spec.ts`: `/` redirects to `/s/<24 chars>`; reload restores the board; New board gives a new id; copy link/id; unknown id page; **legacy import on the served origin:** `page.addInitScript` seeds `chalanamaya.board.v1` (two shapes and a picture) on `http://localhost:5184` before the first visit; the banner appears, import brings everything in as one undo step, the old key stays until **Remove the old copy**.
- `sessions.spec.ts` (phase 2) also: **edit then reload immediately keeps the edit** (draw a box, `page.reload()` without waiting for Saved; the box is there after reload, from the keepalive flush or the pending mirror); the same with the server blocked by `page.route` during the reload.
- `sync.spec.ts` (phase 3): two pages on one session see each other's edits within 1 s, **including bring-to-front and send-to-back** (the layer order matches in both pages and on the server); undo in one does not undo the other's work; offline edits arrive after reconnect.
- `agent.spec.ts`: the test process connects an MCP SDK client to `http://localhost:5184/mcp`, calls `add_elements` (two boxes, a bound connector, a note) and the items appear on the open page within 2 s without reload, with the agent notice; then the user drags a box and `get_scene` reports the new position and the connector still bound. **Edits during a drag:** the user holds a drag (mouse down, several moves) while the agent adds 3 items and changes the colour of another; the user keeps moving, releases, then repeats and presses Esc, then presses undo twice: the agent's 3 items and the colour change are still on the page and in `get_scene`.
- `media.spec.ts`: upload a GIF (two-frame fixture) and a WebM/MP4 fixture (a few KB, made with ffmpeg and committed in `e2e/fixtures/`); move, resize, rotate, layer, group, lock, undo; frames change over time (pixel sampling); PNG export works and shows the poster; a remote GIF URL (served by a tiny second test server on another port in 5000–5999 without CORS headers) animates in the live layer and the eyedropper still works; an agent `place_media kind: "image"` with a remote PNG URL shows the picture live (its `<img>` has `referrerpolicy="no-referrer"`) and a PNG export of the board succeeds and shows the placeholder card; agent `place_media` adds a video live; an agent adds a picture, the user undoes an earlier step, the picture stays.
- `perf.spec.ts`: seed (through the API) 2,000 shapes, 4 uploaded GIFs and 3 uploaded videos in view; with `?perf=1` the app exposes the loop's frame statistics; over 5 s the average animation frame cost is under 16 ms, or the loop has stepped down to 15/10 fps by itself. **Responsiveness is checked separately:** a `PerformanceObserver({type: "longtask"})` installed by the test records no long task over 50 ms during a 1 s drag of a shape while the media plays, and at the end of the drag the shape is at the pointer's position. With an injected 30 ms delay per frame (`?perf=slow`), the loop reaches 10 fps and then pauses with the notice. 30 components and 10 remote videos on screen mount at most 24 live items.
- `components.spec.ts`: add a preset and a custom component; the iframe has `sandbox=""`; a custom component with `<script>`, `onerror` and `javascript:` does nothing (a `window.__pwned` probe stays undefined and no console errors from the frame); it moves and resizes like other items, and its selection frame is visible above it.
- Web card Esc (phase 1): activate by double-click → Esc leaves; activate by Enter → Esc leaves; after clicking into the page, the **Done** button leaves.

## 9. Docs updates

- `docs/out-of-scope.md`: board-session sync is in scope, real collaboration stays out (done with this plan; round 2 made it precise: several tabs or agents editing one session through this server; no accounts, presence, cursors, permissions, hosted service or merging inside one item).
- `docs/README.md`: index entries for specs 06 and 07, scope paragraph, status table rows per phase.
- `docs/features/05-save-open-export.md` (phase 2): FILE-01 changes meaning: the board is saved on the ChalanaMaya server for the session; the browser keeps only unsent changes, preferences and recent boards. FILE-02 notes format version 2 (phase 5).
- `docs/features/01-drawing-tools.md` (phase 1): DRAW-14 acceptance gains "Esc or Done returns to the board".
- New: `docs/agents/setup.md` — Claude Desktop (stdio: `{"command": "node", "args": ["/absolute/path/ChalanaMaya/dist-server/stdio.js"], "env": {"CHALANAMAYA_URL": "http://localhost:5183"}}`), Claude Code (`claude mcp add --transport http chalanamaya http://localhost:5183/mcp`), Cursor / VS Code / generic (HTTP URL or the stdio command). **Cloud agents cannot reach your `localhost`:**
  - **ChatGPT:** custom MCP connectors need **developer mode** turned on (Settings → Apps & Connectors → Advanced) or, in a business workspace, a workspace admin who allows custom connectors; the connector URL must be a **public HTTPS** address (`https://<tunnel>/mcp`) and the authentication setting must be **"No authentication"** (the session id inside each tool call is the only access control). Start the tunnel (for example `cloudflared tunnel --url http://localhost:5183` or ngrok) and set `PUBLIC_URL` so the host check accepts it.
  - **Devin, option A (tunnel):** the same public HTTPS tunnel; add `https://<tunnel>/mcp` as an MCP server (Streamable HTTP, no auth) in Devin's MCP settings; the user keeps the board open in their own browser.
  - **Devin, option B (inside Devin's machine):** Devin clones this repo, runs `npm ci && npm run build && npm start` in its own VM and uses `http://localhost:5183/mcp` there (or the stdio command). The board then lives on Devin's machine: the user watches it in Devin's browser view, or Devin exposes it through a tunnel to share the link. Boards do not move between machines except by `.chalana` export/import.
  - In every exposed setup the doc warns that the session id is then the only protection, recommends a short-lived tunnel, and points to `docs/security.md`.
  Also: the import note for old boards (origins), `ALLOWED_HOSTS` for LAN use, and the `better-sqlite3` pin.
- `docs/agents/mcp-tools.md` (every tool with examples), `docs/security.md`, root `README.md` (how to run; it still says "specifications only").
- `skills/chalanamaya/SKILL.md` and `reference.md`.

## 10. Risks

1. **Live-layer layer order.** CSS components, web cards and remote media sit above the canvas, so a box drawn on top of them still shows under them. Mitigation: documented; uploaded GIF and video draw on the canvas; the top overlay keeps selection visible. A later fix is "band canvases" (split the scene into canvas layers between live items).
2. **Sync correctness.** Echo loops, lost edits, unsynced layer changes and stale derived fields are the main risk. Mitigation: Rules A–F (§3.7), the removal guard, focused unit tests for each hole found in review (reorder by reference, remote batch before flush, stale bindings), the randomised convergence test with binding invariants and a quiet check, and the drag e2e test. If rebasing turns out too fragile, a fallback is to make history store change lists instead of snapshots.
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
13. **Layer keys.** Fractional keys can collide between concurrent writers and grow long. Mitigation: `(idx, id)` order everywhere, strictly increasing keys enforced by `assignKeys` on every local and agent change (duplicate runs re-keyed), re-spread past 64 characters, and a property test.
14. **Cross-site requests to a local server.** Any website the user visits can send simple requests to `localhost`. Mitigation: the cross-site guard (custom header, Origin and `Sec-Fetch-Site` checks) on every state-changing route, `/mcp` and socket upgrades (§7), with integration tests.

## 11. Implementation phases

Each phase ends with `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and `npm run test:e2e` green, its specs' status updated in `docs/README.md`, and a conventional commit on `main`. Each phase can ship alone: users get a working app after every phase.

### Phase 1 — Esc fix, sync-ready scene code and the server shell (SESS-10, DRAW-14 fix)

Delivers:
- **Esc fix:** stop calling `focus()` on the iframe (`WebCards.tsx` lines 32–39); focus the card wrapper (`tabIndex=-1`) so the board document keeps keyboard focus and Esc works right after activation; a **Done** button in the active hint bar (outside the iframe); watch `window` `blur` while `document.activeElement` is the frame to show "Click Done or the board to return" (browsers do not pass key presses out of a cross-origin page); return focus to the board on leave. DRAW-14 acceptance updated.
- **Rule A** (identity-keeping and scoped `finalizeScene`), **Rule C's building blocks** (move/resize/rotate by id against the current state; `rebaseElements`; the remote log with lazy rebasing of history entries, interaction `before` and `textSession.before`, with unit tests, not yet wired to a server) and **Rule E** (`src/shared/keys.ts` `assignKeys` with hint, duplicate-run repair and re-spread, unit and property tests). No visible change for users.
- Canvas measurer moved to `src/ui/measure.ts`; `tsconfig.server.json`; Vitest projects.
- The Node server (`server/`): config (including `ALLOWED_HOSTS`), SQLite schema and migrations, `db:smoke`, `SessionService` (apply with both modes, tombstone versions, quotas), the REST API of §4, picture uploads with metadata (`image-size`), security headers, host check with bare hostnames, the **cross-site request guard**, configurable rate limits, `npm run dev`/`build`/`start` on `localhost:5183`. Playwright runs against the built server on 5184. The app itself still saves to localStorage.

Acceptance:
- Double-click a YouTube web card, press Esc: the card is no longer active (`webcard-active` gone) and board shortcuts work again. Same after Enter activation. After clicking inside the page, **Done** returns to the board. New e2e test covers all three.
- Unit: `finalizeScene` is idempotent by identity (same array object on the second call) for every connector routing; scoped finalize changes only dependents; a move frame computed while a remote item is inserted keeps that item; the layer-key tests of §8 pass (reorders change only moved ids plus labels, duplicate keys never throw).
- `npm start` prints `http://localhost:5183` and serves the app at `/` and `/s/<id>` exactly as before; `GET /api/health` returns `{ok: true}`; start-up fails with a clear message if the database smoke check fails.
- `package.json` pins `better-sqlite3` to `12.11.1`; `npm test` runs `db:smoke`.
- Integration: `POST /api/sessions` returns a 24-character id; ops are validated with `parseElement`; `atomic` rolls back on one bad op; `ack` carries versions for `put` and `del`; oversized bodies get 413; bad ids get 404; uploads check magic bytes and limits and return width/height; `Range` requests return 206; `MAX_SESSIONS`, `MAX_TOTAL_MEDIA_BYTES` and `MAX_DB_BYTES` return 507 with tiny limits; a wrong `Host` header is refused while `localhost:<port>` and `[::1]:<port>` pass; **a cross-origin `text/plain` POST gets 403 and creates no session**, and the other cross-site guard cases of §8 pass.
- Existing unit and e2e suites pass unchanged except for the Playwright `webServer` command.

### Phase 2 — Server-backed sessions in one tab (SESS-01…03, SESS-05, SESS-06, SESS-08)

Delivers: `/` → new session → `/s/<id>`; the board loads from `GET /api/sessions/:id/scene` and saves through `POST /api/sessions/:id/ops` (debounced, built from `LocalChange` with the reference diff **plus re-keyed ids from `assignKeys`**, Rules B and E; `keys` kept in `SyncClient`), replacing localStorage autosave for sessions; the **pending mirror** in localStorage and the **`pagehide` keepalive flush** (§3.7), so the synchronous-save guarantee of today's autosave is kept; Rule D (files add-only, undo keeps files); pictures uploaded to the server; `.chalana` save/open inlining files; Board session menu (title, New board, Copy link, Copy session id, Recent boards); a simple Saved/Saving/Not saved status; legacy localStorage import; FILE-01 spec rewritten; e2e helpers read the server. Two tabs on one session do not update each other live yet (documented as temporary; the later save of an item wins).

Acceptance:
- Opening `/` lands on `/s/<24 chars>`; reload restores elements, layer order, pictures and board colour/grid; theme and viewport stay per browser; unknown ids show the "does not exist" page.
- A normal drag of a box with two bound connectors sends one save containing only the box and the two connectors; **bring to front of a labelled box sends exactly the box and its label, and its undo sends the same two ids** (unit test on the outgoing ops and an integration count).
- E2E: **edit then reload immediately keeps the edit**, also when the server is blocked during the reload (pending mirror).
- Undo after inserting a picture and then another edit keeps the picture file (unit test, Rule D).
- E2E: the old `chalanamaya.board.v1` key seeded on the served origin shows the import banner; import brings in elements and pictures as one undo step; the old copy stays until removed.
- All existing e2e specs pass on the server-backed app (42 tests plus the new ones).

### Phase 3 — Live sync between tabs (SESS-04, SESS-07)

Delivers: the WebSocket protocol of §3.6 (snapshot with tombstones, `changes`/`ack` with versions for `put` and `del`), `SyncClient` (dirty, pending, confirmed incl. tombstone versions, ack, reject notice), `applyRemote` as `rebaseElements(current, ops)` skipping busy ids (Rule B), the remote log wired to lazy rebasing of history, controller and text session (Rule C), the derived-field repair (Rule F), the `needs_layout` correction, reconnect with `sinceRev`, the offline chip and offline queue (media refused while offline), the removal guard.

Acceptance:
- Unit: the randomised two-tab convergence test passes with equal scenes and keys, the binding invariants hold in every replica, and no tab pushes after quiescence; the "remote batch before flush" and "X/C/Y stale binding" tests pass; the removal guard never fires in the suite.
- Two pages on the same session: a box drawn in one appears in the other within 1 s; a delete, a restyle and a bring-to-front/send-to-back in one show in the other with the same layer order; undo in one does not undo the other's work; a change to an item the other tab deleted shows the notice and is not kept; undo of a local delete brings the item back in both pages.
- An item added by the second page while the first page is dragging, cancelling with Esc and undoing is still there afterwards in both pages and on the server.
- Going offline (Playwright `context.setOffline`) shows the offline chip; edits made offline arrive after reconnect, also after a reload; inserting a picture offline shows the notice.

### Phase 4 — MCP server, skill and setup docs (AGENT-01…11, AGENT-13)

Delivers: stateless `/mcp` with the 16 MB express body limit and the Origin check, the stdio bridge (low-level `Server`, raw forwarding, `agent_name` from `getClientVersion()`, 16 MiB buffer), all tools of §5.4 (media tools accept pictures in this phase; remote picture URLs follow the remote rules of §6.2 and use the live layer), `get_scene` paging with `stale_cursor`, loose schemas with strict handler validation, `agent_name`, prompts, resources (no session listing), the agent path with scoped `finalizeScene(next, touched)` and `assignKeys`, server text measuring with `fontkit`, `skills/chalanamaya/`, `docs/agents/setup.md` (with the ChatGPT developer-mode and Devin options of §9), `docs/agents/mcp-tools.md`, `docs/security.md`, the Connect an agent dialog, agent highlight and notice, clear-with-Restore.

Acceptance:
- SDK client integration tests pass for every tool, prompt and resource over HTTP, and for a smoke set plus a 10 MB upload over stdio; a body over 16 MB gets 413; a new client works after a server restart.
- `listTools` equals the documented list; each input schema is flat with descriptions; invalid inputs return `isError` with the field path; unknown fields return warnings; a batch with one bad element changes nothing; an agent call leaves every untouched element byte-identical (no full finalize).
- E2E `agent.spec.ts`: an MCP `add_elements` call (boxes, bound connector, note, frame) shows live in the open page within 2 s with the "Claude added items · Show" notice; a user drag is visible in `get_scene` and the connector stays bound; agent edits during a user's drag, Esc and undo are all kept; an agent `move_elements` of one end while the user drags the other end leaves the connector attached to both in the page and in `get_scene`; an agent `clear_scene` followed by **Restore** brings every item back.
- An agent following only `SKILL.md` can draw a 6-step flowchart with labelled, bound connectors in one `add_elements` call (an integration test uses the skill's own flowchart example verbatim).
- Server-measured label widths are within 5 % of the browser's for the three fonts (e2e compares a few strings).

### Phase 5 — GIF and video elements (MEDIA-01…04, MEDIA-07…10)

Delivers: uploaded GIF playback on the canvas, the `video` element, server metadata for MP4 (`mp4box`) and WebM (`webm.ts`) with the 16:9 fallback and `fileMeta` op, remote pictures/GIFs/videos in the live layer with `referrerpolicy="no-referrer"` and placeholders, export that skips remote files, the eyedropper guard, upload from file and link in the UI (Insert media dialog, drop, paste of files), playback controls (mute per tab), the animation loop with partial redraw and frame budget, video and live-item caps, the top overlay, reduced motion, posters, export fallbacks, `.chalana` version 2, MCP `upload_media`/`place_media`/`add_elements` for `gif` and `video`.

Acceptance:
- A dropped GIF animates on the board (pixel sampling changes over time), can be paused, cropped and flipped. A remote GIF link without CORS animates in the live layer and the eyedropper still works.
- A dropped MP4 or WebM plays muted and looped; Play/Pause/Mute/Loop/Restart work; unmuting in one tab does not unmute another; with `prefers-reduced-motion` GIFs and videos start paused; an upload returns width, height and duration for the fixtures.
- GIF and video move, resize, rotate, group, lock, change layer order (a box above an uploaded video hides part of it), undo/redo and sync to a second tab.
- PNG export shows the GIF's first frame and the video's poster with a play badge, and a placeholder for remote pictures, GIFs and videos without throwing; SVG export embeds the GIF; a `.chalana` save reopens with media.
- Oversized, wrong-type and SVG uploads are refused with a clear message; remote URLs with private, single-label or `.internal` hosts are refused.
- `perf.spec.ts` passes: frame cost under budget or stepped down, **no long task over 50 ms during a 1 s drag while media plays**, slow mode pauses, at most 24 live items mounted.
- An agent `place_media` with a video file appears live in the browser (e2e).

### Phase 6 — Animated CSS components and hardening (MEDIA-05, MEDIA-06, SESS-09)

Delivers: `component` element, presets, custom HTML/CSS dialog with live preview and limits, the fixed `srcdoc` shell (CSP `<meta>` first, filtered CSS in `<style>`, DOMPurify-cleaned body with `FORBID_TAGS` including `style`, `link`, `meta`), sandboxed rendering in `LiveLayer` (inside the 24-item cap), static fallbacks for export, MCP support (`add_elements` type `component`, `list_component_presets`, resource); delete board; empty-session clean-up and optional TTL; performance checks (5,000 elements: load < 2 s, remote batch of 200 applied < 100 ms end to end); final pass on all docs and the root README.

Acceptance:
- Each preset can be added from the UI and by an agent, with parameters; it animates and moves/resizes/rotates/groups/locks/undoes like other items, with its selection frame visible.
- Every component iframe has `sandbox=""` and its `srcdoc` starts with the CSP `<meta>` (checked in e2e and unit); the attack corpus does not execute script, load remote resources, close the `<style>` element or navigate (e2e probe and unit corpus).
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

## 13. Review answers

### Round 3

| Finding | Fix | Where |
| --- | --- | --- |
| B1 layer order not synced; duplicate keys crash `generateKeyBetween` | `keys: Map<id, string>` in `SyncClient`; `assignKeys(prev, next, keys, hint)` after every local and agent change, re-keyed ids added to `put`; hint stored in history so undo/redo of a reorder push the same ids; `(idx, id)` order on both sides; strictly increasing keys, duplicate runs re-keyed, never called with `a >= b`; unit, property and e2e tests | §2, §3.2, §3.7 Rules B and E, §3.9, §8; phases 1–3 |
| B2a remote batch wipes unflushed local edits | `applyRemote = rebaseElements(current, ops)` skipping ids in `dirty ∪ pending`; skipped ops only update `confirmed`; test "remote batch between edit and flush" | §3.7 Rule B; §8; phase 3 |
| B2b stale derived fields (connector C, bound labels) | Rule F: scoped `finalizeScene(touched = remote ids)` after `applyRemote`, accepted only for busy elements (and the height of a busy label's container), then pushed; convergence test asserts binding invariants and stays quiet; X/C/Y test; e2e agent-vs-user drag | §3.7 Rule F; §8; phases 3, 4 |
| B3 CSRF from other websites | cross-site guard: `X-ChalanaMaya: 1` on state-changing REST routes (forces a preflight that fails without CORS), `Sec-Fetch-Site: cross-site` refused, Origin allow-list on REST, `/mcp` and sockets; integration tests (text/plain cross-origin POST → 403) | §4, §7, §8; phase 1 |
| Minor: `hostHeaderValidation` ignores ports | bare hostnames `localhost`, `127.0.0.1`, `[::1]` + `PUBLIC_URL` hostname + `ALLOWED_HOSTS` | §5.1, §7 |
| Minor: two body limits | one mechanism: `express.json({limit: "16mb"})` + `parsedBody`; 413 test | §5.1, §8 |
| Minor: stdio bridge design | low-level `Server` + `setRequestHandler`, raw `client.request` forwarding (no `callTool` output validation), `agent_name` from `getClientVersion()` | §5.1, §8 |
| Minor: full finalize on the server | `finalizeScene(next, touched)` with agent-touched ids only; test that untouched elements stay byte-identical | §3.9, §8 |
| Minor: rebase cost | lazy rebasing from a latest-per-id remote log with `seq`; shared element instances; performance tests | §3.7 Rule C, §8 |
| Minor: tombstone versions | `ack.versions` and `changes` carry `del` versions; client keeps them; `snapshot.tombstones` | §3.6 |
| Minor: remote static pictures | same rules as remote GIF/video: live layer, placeholder in export, export skips remote files, `referrerpolicy="no-referrer"` | §6.2, §6.4, §7, §8 |
| Minor: media metadata | `image-size`, `mp4box`, own WebM EBML reader; 16:9 fallback with "contain"; `fileMeta` op | §3.2, §3.6, §6.1 |
| Minor: phase 2 save loss on reload | pending mirror and `pagehide` keepalive flush moved to phase 2; e2e "edit then reload immediately" | §3.7, §8, phase 2 |
| Minor: weak perf assertion | long-task observer: no task over 50 ms during a 1 s drag while media plays | §8, phase 5 |
| Minor: component `srcdoc` | fixed shell, CSP `<meta>` first, CSS only via the CSS filter, DOMPurify on the body fragment with `FORBID_TAGS` `style`/`link`/`meta`… | §6.3, phase 6 |
| Minor: paging across revisions | cursor encodes `rev` + `(idx, id)` + filter hash; `stale_cursor` when the rev changed | §5.4, §8 |
| Minor: ChatGPT and Devin setup | ChatGPT developer mode or admin, public HTTPS, "No authentication"; Devin via tunnel or inside its own VM | §9 |

### Round 2

| Finding | Fix | Where |
| --- | --- | --- |
| B1 echo loop | `finalizeScene` keeps identity and is scoped; local and remote paths split; dirty sets; convergence test with quiet check | §3.7 Rules A, B; §8; phases 1–3 |
| B2 data loss during interactions | by-id interactions; history, `before` and `textSession.before` rebased (lazily since round 3); `del` only for removed ids; removal guard; unit and e2e tests | §3.7 Rules B, C; §8; phases 1, 3, 4 |
| B3 files in undo | files add-only in sessions; undo keeps current files; test | §3.7 Rule D; phase 2 |
| B4 remote media | remote media in the live layer without `crossOrigin`; canvas never tainted; eyedropper guard; uploads drawn on canvas | §6.2–6.4; phase 5 |
| B5 better-sqlite3 | exact pin 12.11.1; `db:smoke` at start-up and in tests; risk 5 | §3.2, §3.4, §3.5, §10 |
| B6 import origin | default `http://localhost:5183` (old dev origin), `PORT=5184` for old preview boards; e2e seeds the key on the served origin | §3.4, §4, §8 |
| B7 global caps and performance | `MAX_SESSIONS`, `MAX_TOTAL_MEDIA_BYTES`, `MAX_DB_BYTES` (507); live-item cap 24, videos only on screen with `preload="none"`; partial redraw and adaptive frame rate; perf e2e | §6.3, §7, §8; phase 5 |
| Minors (host check, body limits, stdio buffer, flat schemas, atomic batches, layout and poster ops, server text measuring, `npx`/shebang, stateless MCP, no enumeration, rate limits in tests, mute per tab, selection above live items, URL rules, phase split, dev CSP, offline media, `update_session`, server tsconfig) | as listed in round 2; refined in round 3 where noted above | §3–§7, §11 |
