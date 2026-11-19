# ChalanaMaya on Cloudflare — implementation plan

Goal: host ChalanaMaya publicly on Cloudflare, cheap enough to give free access, with no
always-on server and no traditional database. Deploy target: `*.workers.dev` (custom domain later).

## 1. Chosen architecture — Worker + static assets + Durable Object per board + R2

**Shape: one Worker serving the Vite build as static assets, plus one SQLite-backed
Durable Object (DO) per board, plus an R2 bucket for media.**

The frontend already builds to static assets, so this shape keeps every feature that
matters — real-time collaboration, shared boards, MCP for invited agents — inside
Cloudflare serverless primitives. The two rejected alternatives:

- **Static-assets-only**: $0 and trivial, but the app never boots — `Boot.tsx` calls
  `httpApi.createSession()` before the canvas loads, and it also drops collab, MCP, and
  shared boards (requirements 4–5). Dead end, not a phase.
- **Fully-durable store** (long-lived boards in DO storage): conflicts with the
  "persistence is user-owned" model and invites storage-cap pressure. We keep DO SQLite
  as the live-session store but treat boards as **ephemeral-by-policy**: idle boards are
  evicted; the `.chalana` download is the only durable copy.

### Topology

```
browser ──► Worker (static assets + router)
              ├─ /s/<viewId>                      → index.html (SPA)
              ├─ /api/health                      → liveness
              ├─ /api/sessions                    → create board (DO)   [rate-limited per IP]
              ├─ /api/sessions/<id>/*             → DO stub for board <id>
              │     (GET scene, ops, import, links, files, delete —
              │      9 board routes, same shapes as today)
              ├─ /api/sessions/<id>/socket        → DO WebSocket (hibernation)
              ├─ /api/sessions/<id>/files/<fid>   → R2 stream (existing route shape kept)
              └─ /mcp                             → stateless MCP POST → resolve board → DO stub
```

- **Board DO (`BoardSession`)**: owns the whole per-board authority — elements, ops,
  push_log dedup, tombstones, key hashes, WebSocket fan-out. SQLite storage backend
  (`new_sqlite_classes`) is required: it is the only DO storage class on the free tier.
  The existing `server/db/schema.ts` tables map ~1:1; all `better-sqlite3` prepared
  statements are rewritten to `ctx.storage.sql` inside `ctx.storage.transaction(...)`.
- **Worker**: thin router + security middleware (Host/Origin, CSP, rate limit) +
  static assets. No per-request DB work; every board call ends in one DO stub call.
- **R2**: media blobs, served on the **existing** route `/api/sessions/<id>/files/<fileId>`
  (DO stores `{r2key, mime, size, hash}` per file; Worker streams GETs with
  `X-Content-Type-Options: nosniff`). No new canonical media path — stored FileMaps,
  PNG-embedded scenes, autosaves and clipboard payloads already carry this URL shape.
- **Ephemerality**: each DO board carries `lastActivity`; an alarm evicts the board
  (delete storage + R2 objects) after **7 days idle**, and a lightweight global LRU
  (a small DO index or periodic cron Worker listing keys) caps total boards at
  ~5 GB DO storage / ~10 GB R2. Clients are told a board is gone (410) and offered
  re-upload of their `.chalana` file — which is exactly requirement 3.
- **Free-tier fit**: Workers 100k req/day & 10 ms CPU; DO 100k req/day + 13,000 GB-s/day
  + **SQLite rows written 100k/day, rows read 5M/day**; **every inbound/outbound
  WebSocket message on the DO counts as a DO request**, so ops writes + push_log inserts
  + broadcast fan-out can exhaust the daily budget well before the headline request cap
  on a busy public board; R2 10 GB + zero egress. Over the daily cap: requests fail
  until UTC reset — no bill. The existing `src/sync/mirror.ts` pending queue already
  degrades gracefully through an outage; Phase 5 adds explicit cap-exhaustion UX
  ("board is read-only until the daily capacity resets"). Eviction frees storage, not
  the daily write budget — the caps are why per-board DO quotas (below) matter.

## 2. Security / invite model (concrete)

Three secrets per board, minted inside the DO at `POST /api/sessions`:

- `viewId` — public board id in the URL `/s/<viewId>`. Grants **read + live view** only.
- `editKey` — 128-bit secret, carried as the URL **fragment** `/s/<viewId>#key=<editKey>`
  (a fragment is never sent to the server, never logged, never leaked by copy/paste of a
  view URL, and never hits Referer). It is sent explicitly as
  `Authorization: Bearer <editKey>` on REST calls and as `key` on the WS hello.
- `ownerKey` — 128-bit secret, required for `editKey` rotation/revocation and board
  delete. Delivered once in the create response and shown to the creator as a separate
  **owner link** `/s/<viewId>#owner=<ownerKey>` ("copy owner link — keep it safe"). The
  client holds it in **sessionStorage** (survives tab reloads, dies with the tab — same
  lifetime as an owner's editing session, and never in localStorage where it would
  outlive the browser). If the owner loses it, the board is still editable by key
  holders but rotation is gone — that consequence is stated next to the copy button.

DO stores **SHA-256 hashes only**, of `viewId`, each `editKey`, and `ownerKey`.

Enforcement lives in the DO (single-threaded authority): WS push, `/ops`, `/import`,
`/links`, `/files`, `DELETE`, and every MCP write tool require a valid edit key; rotation
and delete additionally require `ownerKey`. Reads need only `viewId`. An unapproved
user/agent gets the scene and live updates **view-only**; mutating calls return
`403 {code:"edit_forbidden"}` — the client then locks into the existing look-only mode.
This fixes today's gap where look-only is a client-side flag with no server check.

- **v1 approval UX = out-of-band links** (ship first): board creation returns view /
  invite (keyed) / owner links. Menu gains two items — **"Copy invite link"** (grants
  edit) and **"Copy view-only link"** (strips the key) — so nobody silently shares edit
  rights by copying the address bar. Anyone with the invite link can edit, agents
  included.
- **v2 in-app request/approve** (later phase, not blocking launch): a keyed client may
  mint single-use *request tokens*; owner tabs get a WS notice and approve, which stores
  a new key hash. Only if users ask.
- **Revocation**: a client presenting `ownerKey` rotates `editKey` in the DO; the old
  key dies. (Recovery story above: owner key lives in the owner link + sessionStorage.)
- **Carried over unchanged**: Host/Origin allowlist (`*.workers.dev` now, custom domain
  added to the same list later), strict element validation (`src/shared/validate.ts`
  is isomorphic — reuse in DO), media magic-byte sniffing, CSP headers, ids/keys never
  listed or logged.
- **Rate limits**: `POST /api/sessions` and `/api/sessions/<id>/import` behind
  Cloudflare's per-IP `ratelimits` binding (10 boards/IP/day to start). The binding is
  **per-location and approximate**, a first line of defense only — the real enforcement
  is the existing per-board quotas (element count, file size, and a new per-board
  daily ops/rows budget) enforced inside the DO, which is where the free-tier caps
  actually bite.

## 3. Drawing file format — `.chalana` round-trips full scene incl. media

Keep `src/io/serialize.ts` **unchanged** as the format: `type:"chalana"`, `version:2`,
`{elements, files:FileMap, settings}`. The round-trip is **already correct** and the
plan adds no new work here:

- Export already inlines server-held files: `App.tsx`/`src/io/flows.ts` call
  `inlineFiles` before `serializeBoard`, turning `/api/.../files/<id>` URLs into
  base64 data URLs so a downloaded board is self-contained.
- Import already re-hosts media client-side: `src/sync/importBoard.ts` → `adoptFiles`
  uploads each data-URL entry through the existing per-file `POST /files` route and
  remaps fileIds. **No DO-side "decode base64 → re-sniff → write R2" path is added** —
  the DO `/import` route accepts elements + FileMap references only; bytes arrive via
  `/files` exactly as today.
- `source:"remote"` *link* entries stay links by design (v2 spec).
- Format version stays `2`; no `version:3` needed since embedding is already legal.
- A `.chalana` file is therefore the only durable artifact a user needs; board eviction
  loses nothing the user downloaded.

## 4. Server → Cloudflare port map

| Node today | Cloudflare replacement | Notes |
|---|---|---|
| `server/app.ts` Express + static + upgrade | `worker/index.ts` router + assets binding + `fetch` upgrade forward to DO | Host/Origin + CSP middleware port |
| `server/api/routes.ts` 10 routes (9 board + `/health`) | same routes, DO-backed handlers (`worker/do/board.ts`) | request/response shapes unchanged → `src/sync/api.ts` untouched except auth header |
| `server/sessions/service.ts` SessionService | inside `BoardSession` DO | transactional apply, push_log, validation, quotas, tombstones, `applyAgentChange` all move into DO methods; better-sqlite3 → `ctx.storage.sql` |
| `server/db/schema.ts` | `worker/do/schema.sql` init on first DO use | near-verbatim SQL |
| `server/sync/socket.ts` SyncCore | DO class + `ctx.acceptWebSocket` + `webSocketMessage`/`webSocketClose` + hibernation | `SyncTransport` interface already abstracts the socket — ports near-verbatim; attachments survive hibernation via `serializeAttachment` |
| `server/mcp/*` (Streamable HTTP, 17 tools, per-request McpServer) | `worker/mcp.ts`: verify SDK runs on Workers; if not, hand-roll JSON-RPC dispatch (tools list is finite and request-shaped). Every tool resolves `session_id`/URL → DO stub; write tools require edit key | `server/mcp/tools.ts`, `elements.ts`, `view.ts`, `palette.ts`, `guide.ts` move mostly unchanged — they call SessionService, now the DO |
| `server/media/{sniff,videoMeta}` | `worker/media.ts` | pure byte logic — copy |
| `server/text/measure.ts` (fontkit + @fontsource fs) | **approximate metrics in DO** + existing `needs_layout` browser-correction flag | bundling fontkit+fonts into a Worker is fragile/heavy; measure.ts already has a fallback path — use it server-side, browser corrects on first render |
| `server/security/*` | `worker/security.ts` middleware | host/csrf/headers/rateLimit ported; express-rate-limit → CF rate-limit binding |
| `server/stdio.ts` | **unchanged code, stays external**: stdio bridge pointed at `https://<app>.workers.dev/mcp` via `CHALANAMAYA_URL` **plus a key channel** — `CHALANAMAYA_KEY` env var, or a `key`/`#key=` in the URL, forwarded as `Authorization: Bearer` on every MCP request | published bin keeps working for hosted agents |
| better-sqlite3, express, ws, fontkit | devDeps only (Node server kept for self-host? — decision below) | |

**Node server disposition**: keep `server/` compiling and tested during migration
(it's the reference implementation and self-host path); the plan never *deletes* it.
`npm run build`/`test` keep the Node variant green until the Worker reaches parity;
final phase removes express/better-sqlite3/ws/fontkit from `dependencies` only if we
decide to drop self-host — flagged as an open question, not assumed.

## 5. MCP & hosted agents

- `/mcp` on the Worker accepts streamable-HTTP POST, stateless per request (as today).
  SDK check first: `@modelcontextprotocol/sdk` StreamableHTTPServerTransport uses
  Web-standard primitives; if it runs, zero rewrite. Fallback: minimal JSON-RPC 2.0
  handler dispatching the existing tool table (it's already a pure function map).
- Auth: an agent is just a client. `parseSessionRef` (`src/shared/ids.ts`) today strips
  everything after the id — it is extended to also extract a `key` from the URL
  (`#key=` fragment or `?key=` for backward input) and return `{id, key}`; MCP tool
  resolution forwards the key to the DO as Bearer. A bare `session_id` plus
  `Authorization: Bearer <editKey>` header works too. View-link-only access → read
  tools only (`get_scene`, `screenshot`-style view tools); write tools return the
  same 403.
- Stdio bridge: code unchanged shape, docs updated — `CHALANAMAYA_URL` may embed
  `#key=`/`?key=`, or `CHALANAMAYA_KEY=<editKey>` sets the Bearer header for every
  request.
- **Phase 3 ships before R2** (Phase 4): media tools that need storage
  (`upload_media` with `data_base64`, file-source options) return an explicit
  "media upload unavailable on this deployment" error until Phase 4 lands; URL-link
  media (`source.url`) works throughout since no storage is needed.

## 6. File change list

**New (`worker/`)**: `worker/index.ts` (router+assets), `worker/do/board.ts` (BoardSession
DO), `worker/do/schema.sql`, `worker/do/service.ts` (ported SessionService), `worker/do/socket.ts`
(WS hibernation), `worker/mcp.ts`, `worker/security.ts`, `worker/media.ts`,
`wrangler.toml`, `worker/README.md`.

**Moved/adapted**: `server/sessions/service.ts` → `worker/do/service.ts` (SQL rewrite);
`server/sync/socket.ts` SyncCore → `worker/do/socket.ts`; `server/media/{sniff,videoMeta}.ts`
→ `worker/media.ts`; `server/security/*` → `worker/security.ts`; `server/mcp/*` tool
implementations → imported by `worker/mcp.ts` (kept Node-compatible so `server/` still
tests green); `server/text/measure.ts` → approximate-metrics module shared by DO.

**Frontend edits**: `src/shared/ids.ts` (parse `key` alongside id);
`src/sync/session.ts`/`Boot.tsx` (read `#key=`/`#owner=` from the fragment, hold in
memory, `ownerKey` mirrored to sessionStorage, never localStorage); `src/sync/api.ts`
(Bearer on mutating calls + file GETs; treat 403 → lock look-only);
`src/sync/client.ts` (send key on push, handle 403); `src/sync/live.ts` (send key in
WS hello; 4403/403 → look-only); `src/ui/MainMenu.tsx`/`src/ui/Dialogs.tsx` ("Copy
invite link", "Copy view-only link", owner-link copy at creation, look-only notice on
rejected edit, "board read-only until capacity resets" notice).

**Config/CI**: `package.json` (wrangler devDep, `deploy`/`dev:cf` scripts; express/
better-sqlite3/ws/fontkit moved to devDeps only in the final phase if self-host dropped),
`vite.config`/`wrangler.toml` (assets binding to `dist/`), `tsconfig` for worker types
(`@cloudflare/workers-types`), eslint/prettier include `worker/`, CI workflow gains a
`wrangler deploy` job (skipped until secrets set).

**Tests**: `worker/*.test.ts` — DO service tests via `cloudflare:test` pool
(`@cloudflare/vitest-pool-workers`); ported `server/api.test.ts`, `service.test.ts`,
`socket.test.ts`, `sync/convergence.test.ts` cases against the DO; e2e `server.spec.ts`
gets a `WORKERS_DEV` target.

**Docs**: `docs/security.md` (three-secret model), `docs/plans/cloudflare-hosting-plan.md`
(this file), README deploy section.

## 7. Phases — each independently verifiable, repo stays green

Green = `npm run lint && npm run typecheck && npm run test && npm run build` pass on the
Node stack throughout; Worker code typechecks/tests from the phase it's added.

### Phase 1 — Worker + Board DO + REST parity (deploy together)

Goal: a live `*.workers.dev` URL where the app boots, boards are shared over HTTP,
and `.chalana` round-trip works end to end. (The old "static-only Phase 0" was
unreachable: the app boots only after `POST /api/sessions` creates a board, so the
Worker and the DO must deploy together.)
Scope: `wrangler.toml` + `worker/index.ts` (static assets + SPA fallback for `/s/*`);
`worker/do/{board,service,schema}.ts`; all 9 board routes + `/health` DO-backed;
three-secret mint/check; per-IP create rate limit; 403→look-only client handling;
`#key=`/`#owner=` plumbing; manual `wrangler deploy` with the existing
CLOUDFLARE_API_TOKEN secret.
Acceptance: vitest-pool-workers port of service/api tests green; workers.dev URL
serves the app and creates boards; draw → download → wipe → upload → identical scene
incl. images; two browsers see each other's edits after manual refresh/poll; keyed
editor edits, view-only visitor is rejected on writes; Node stack still green.

### Phase 2 — WebSocket collab (hibernation)

Goal: real-time parity with the Node server.
Scope: `worker/do/socket.ts` (SyncCore port + `acceptWebSocket` + attachments +
hibernation alarm); key on WS hello; idle-eviction alarm (7-day TTL) + 410 gone path;
per-board daily ops/rows budget counters.
Acceptance: ported socket/convergence tests green; two tabs edit live concurrently on
workers.dev; idle socket hibernates (no DO duration burn); evicted board returns 410 and
offers re-upload.

### Phase 3 — MCP on Workers

Goal: invited agents draw on hosted boards.
Scope: `worker/mcp.ts` (SDK transport if it runs, else JSON-RPC dispatch); tool modules
rewired to DO; `parseSessionRef` extended to carry the key; stdio bridge key channel
(`CHALANAMAYA_KEY` / key in URL); view-only agent gets read tools only; media-write
tools refuse with "media unavailable" until Phase 4.
Acceptance: ported `mcp/http.test.ts` green; `npx chalanamaya-mcp` stdio bridge against
workers.dev executes a write tool end-to-end with an edit link, and is rejected without
a key; MCP over POST works from a remote client.

### Phase 4 — R2 media

Goal: hosted image/video/file upload + download on the existing route shape.
Scope: R2 binding; `POST /api/sessions/<id>/files` + `GET /api/sessions/<id>/files/<fid>`
streamed from R2 (no `/media/<key>` path — stored FileMaps keep working); sniff port;
eviction deletes objects.
Acceptance: upload image → renders on a second client; downloaded `.chalana` inlines it
(existing `inlineFiles` path); import restores it via existing `adoptFiles` → `/files`;
media tests green; MCP `upload_media` unblocked.

### Phase 5 — Hardening, abuse controls, cleanup

Goal: production-grade for public free access.
Scope: rate limits tuned (create/import/ops), cap-exhaustion UX (mirror queue notice,
"board is read-only until the daily capacity resets"), board-count LRU sweeper cron
Worker, CSP/Host allowlist final, `docs/security.md` update, README deploy docs;
decide & either drop `server/` Node deps or keep self-host; v2 in-app request/approve
only if demanded.
Acceptance: soak — N boards, sustained edit traffic stays within free caps incl. DO
rows-written (checked via CF analytics); `wrangler deploy` reproducible from CI; full
green suite incl. e2e against workers.dev.

## 8. Test & deploy strategy

- **Unit**: `vitest` stays. Worker-side tests use `@cloudflare/vitest-pool-workers`
  (real DO/WS/R2 emulation in workerd) — new `test:worker` script; ported suites mirror
  the Node ones, run in the same `npm test`.
- **e2e**: Playwright specs gain a base-URL env (`E2E_BASE_URL`) so `server.spec.ts`/
  `sessions.spec.ts`/`sync.spec.ts` run against `*.workers.dev` as a deploy gate.
- **Deploy**: `wrangler deploy` from `devin/cloudflare-host` → `chalanamaya.workers.dev`
  (name TBD); CI job gated on `CLOUDFLARE_API_TOKEN` + account id (both already
  available as org secrets). Migrations: none — DO SQLite initializes itself.
- **Rollback**: workers.dev versions + `wrangler rollback`; Node self-host path kept
  until Phase 5 decision.
- **Free-tier alarms**: CF notifications on Workers/DO/R2 usage thresholds **including
  DO SQLite rows-written and DO request count**; a "capacity" page when daily caps trip.

## 9. Open questions resolved / deferred

1. **TTL**: 7-day idle eviction + global LRU — boards are ephemeral, `.chalana` is the
   store. (Answers Q1.)
2. **MCP SDK on Workers**: try SDK first, hand-rolled JSON-RPC fallback — decided in
   Phase 3 with a 1-hour spike. (Q2.)
3. **Fonts**: approximate metrics + `needs_layout` correction; no fontkit on Workers. (Q3.)
4. **Approval UX**: v1 out-of-band links (view / invite / owner); v2 in-app approve
   deferred to post-launch. (Q4.)
5. **Media**: R2 from Phase 4; earlier phases work with URL links + inlined base64
   exports only. (Q5.)
6. **Abuse**: per-IP create limit (approximate, per-location) + per-board DO quotas
   (elements, files, daily ops/rows budget — the real enforcement) + cap-exhaustion UX.
   (Q6.)
7. **Node server**: kept green through migration; drop-or-keep decided at Phase 5.
