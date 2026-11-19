# ChalanaMaya on Cloudflare — implementation plan

Goal: host ChalanaMaya publicly on Cloudflare, cheap enough to give free access, with no
always-on server and no traditional database. Deploy target: `*.workers.dev` (custom domain later).

## 1. Chosen architecture — Worker + static assets + Durable Object per board + R2

**Shape: one Worker serving the Vite build as static assets, plus one SQLite-backed
Durable Object (DO) per board, plus an R2 bucket for media.**

The frontend already builds to static assets, so this shape keeps every feature that
matters — real-time collaboration, shared boards, MCP for invited agents — inside
Cloudflare serverless primitives. The two rejected alternatives:

- **Static-assets-only**: $0 and trivial, but drops collab, MCP, and shared boards
  (requirements 5). Dead end, not a phase — only used as a smoke-test deploy, not a target.
- **Fully-durable store** (long-lived boards in DO storage): conflicts with the
  "persistence is user-owned" model and invites storage-cap pressure. We keep DO SQLite
  as the live-session store but treat boards as **ephemeral-by-policy**: idle boards are
  evicted; the `.chalana` download is the only durable copy.

### Topology

```
browser ──► Worker (static assets + router)
              ├─ /s/<viewId>            → index.html (SPA)
              ├─ /api/sessions          → create board (DO)   [rate-limited per IP]
              ├─ /api/sessions/<id>/*   → DO stub for board <id> (REST: scene, ops,
              │                            import, links, files, media, delete)
              ├─ /api/sessions/<id>/socket → DO WebSocket (hibernation)
              ├─ /mcp                   → stateless MCP POST → resolve board → DO stub
              └─ /media/<key>           → R2 (content-type sniffed, noexec)
```

- **Board DO (`BoardSession`)**: owns the whole per-board authority — elements, ops,
  push_log dedup, tombstones, key hashes, WebSocket fan-out. SQLite storage backend
  (`new_sqlite_classes`) is required: it is the only DO storage class on the free tier.
  The existing `server/db/schema.ts` tables map ~1:1; all `better-sqlite3` prepared
  statements are rewritten to `ctx.storage.sql` inside `ctx.storage.transaction(...)`.
- **Worker**: thin router + security middleware (Host/Origin, CSP, rate limit) +
  static assets. No per-request DB work; every board call ends in one DO stub call.
- **R2**: media blobs. DO stores `{r2key, mime, size, hash}` per file; Worker streams
  GETs with `X-Content-Type-Options: nosniff`.
- **Ephemerality**: each DO board carries `lastActivity`; an alarm evicts the board
  (delete storage + R2 objects) after **7 days idle**, and a lightweight global LRU
  (a small DO index or periodic cron Worker listing keys) caps total boards at
  ~5 GB DO storage / ~10 GB R2. Clients are told a board is gone (410) and offered
  re-upload of their `.chalana` file — which is exactly requirement 3.
- **Free-tier fit**: Workers 100k req/day & 10 ms CPU (DO calls don't count Worker CPU
  heavily), DO 100k req/day + 13,000 GB-s/day (hibernating sockets ~free), R2 10 GB +
  zero egress. Over the daily cap: requests fail until UTC reset — no bill. The existing
  `src/sync/mirror.ts` pending queue already degrades gracefully through an outage.

## 2. Security / invite model (concrete)

Dual-capability secrets per board, minted inside the DO at `POST /api/sessions`:

- `viewId` — public board id in the URL `/s/<viewId>`. Grants **read + live view** only.
- `editKey` — 128-bit secret, delivered as `/s/<viewId>?key=<editKey>` or
  `Authorization: Bearer <editKey>`; also accepted as a `key` field on the WS hello and
  on MCP session resolution (`session_id` already accepts a full URL, so the invite link
  carries it). DO stores **SHA-256 hashes only**, of `viewId` and each `editKey`.

Enforcement lives in the DO (single-threaded authority): WS push, `/ops`, `/import`,
`/links`, `/files`, `DELETE`, and every MCP write tool require a valid edit key. Reads
need only `viewId`. An unapproved user/agent gets the scene and live updates
**view-only**; mutating calls return `403 {code:"edit_forbidden"}` — the client then
locks into the existing look-only mode. This fixes today's gap where look-only is a
client-side flag with no server check.

- **v1 approval UX = out-of-band edit link** (ship first): board creator gets the keyed
  URL once (in `POST /api/sessions` response + a "copy invite link" menu item) and shares
  it themselves. Anyone with the link can edit — including agents pointed at it.
- **v2 in-app request/approve** (later phase, not blocking launch): a keyed client may
  mint single-use *request tokens*; owner tabs get a WS notice and approve, which stores
  a new key hash. Only if users ask.
- **Revocation**: owner (any keyed client holding the *owner key*, a third secret minted
  with the board and kept out of the URL) rotates `editKey` in the DO; old key dies.
- **Carried over unchanged**: Host/Origin allowlist (`*.workers.dev` now, custom domain
  added to the same list later), strict element validation (`src/shared/validate.ts`
  is isomorphic — reuse in DO), media magic-byte sniffing, CSP headers, ids/keys never
  listed or logged.
- **Rate limits**: `POST /api/sessions` and `/api/sessions/<id>/import` behind
  Cloudflare's per-IP `ratelimits` binding (10 boards/IP/day to start); plus the existing
  per-board quotas (element count, file size) enforced in the DO.

## 3. Drawing file format — `.chalana` round-trips full scene incl. media

Keep `src/io/serialize.ts` **unchanged** as the format: `type:"chalana"`, `version:2`,
`{elements, files:FileMap, settings}`. The one change required by serverless media:
**file export must inline every remote/R2-backed blob as base64 data URLs**, the same
way today's `files` map embeds content — so a downloaded board is self-contained and
uploading it anywhere restores identically.

- Export (`src/io/export.ts` / `flows.ts`): before writing, walk the FileMap; for every
  entry whose content is an `/media/<key>` or remote URL reference, fetch bytes →
  base64 → embed. `source:"remote"` *link* entries stay links by design (v2 spec).
- Import (`src/sync/importBoard.ts` + DO `/import`): accepts data-URL entries, decodes,
  re-sniffs (`server/media/sniff.ts` port), writes to R2, rewrites FileMap to the new
  keys. Same code path handles a file exported from the old Node server — data-URL
  FileMaps already round-trip today.
- Format version stays `2`; no `version:3` needed since embedding is already legal.
- A `.chalana` file is therefore the only durable artifact a user needs; board eviction
  loses nothing the user downloaded.

## 4. Server → Cloudflare port map

| Node today | Cloudflare replacement | Notes |
|---|---|---|
| `server/app.ts` Express + static + upgrade | `worker/index.ts` router + assets binding + `fetch` upgrade forward to DO | Host/Origin + CSP middleware port |
| `server/api/routes.ts` 9 REST routes | same routes, DO-backed handlers (`worker/do/board.ts`) | request/response shapes unchanged → `src/sync/api.ts` untouched |
| `server/sessions/service.ts` SessionService | inside `BoardSession` DO | transactional apply, push_log, validation, quotas, tombstones, `applyAgentChange` all move into DO methods; better-sqlite3 → `ctx.storage.sql` |
| `server/db/schema.ts` | `worker/do/schema.sql` init on first DO use | near-verbatim SQL |
| `server/sync/socket.ts` SyncCore | DO class + `ctx.acceptWebSocket` + `webSocketMessage`/`webSocketClose` + hibernation | `SyncTransport` interface already abstracts the socket — ports near-verbatim; attachments survive hibernation via `serializeAttachment` |
| `server/mcp/*` (Streamable HTTP, 17 tools, per-request McpServer) | `worker/mcp.ts`: verify SDK runs on Workers; if not, hand-roll JSON-RPC dispatch (tools list is finite and request-shaped). Every tool resolves `session_id`/URL → DO stub; write tools require edit key | `server/mcp/tools.ts`, `elements.ts`, `view.ts`, `palette.ts`, `guide.ts` move mostly unchanged — they call SessionService, now the DO |
| `server/media/{sniff,videoMeta}` | `worker/media.ts` | pure byte logic — copy |
| `server/text/measure.ts` (fontkit + @fontsource fs) | **approximate metrics in DO** + existing `needs_layout` browser-correction flag | bundling fontkit+fonts into a Worker is fragile/heavy; measure.ts already has a fallback path — use it server-side, browser corrects on first render |
| `server/security/*` | `worker/security.ts` middleware | host/csrf/headers/rateLimit ported; express-rate-limit → CF rate-limit binding |
| `server/stdio.ts` | **unchanged, stays external**: stdio bridge pointed at `https://<app>.workers.dev/mcp` via `CHALANAMAYA_URL` | published bin keeps working for hosted agents |
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
- Auth: an agent is just a client — `session_id` accepts the keyed invite URL, or
  `Authorization: Bearer <editKey>` header. View-link-only access → read tools only
  (`get_scene`, `screenshot`-style view tools); write tools return the same 403.
- Stdio bridge: unchanged. Docs updated to `CHALANAMAYA_URL=https://…workers.dev`.

## 6. File change list

**New (`worker/`)**: `worker/index.ts` (router+assets), `worker/do/board.ts` (BoardSession
DO), `worker/do/schema.sql`, `worker/do/service.ts` (ported SessionService), `worker/do/socket.ts`
(WS hibernation), `worker/mcp.ts`, `worker/security.ts`, `worker/media.ts`, `worker/ratelimit.ts`,
`wrangler.toml`, `worker/README.md`.

**Moved/adapted**: `server/sessions/service.ts` → `worker/do/service.ts` (SQL rewrite);
`server/sync/socket.ts` SyncCore → `worker/do/socket.ts`; `server/media/{sniff,videoMeta}.ts`
→ `worker/media.ts`; `server/security/*` → `worker/security.ts`; `server/mcp/*` tool
implementations → imported by `worker/mcp.ts` (kept Node-compatible so `server/` still
tests green); `server/text/measure.ts` → approximate-metrics module shared by DO.

**Frontend edits**: `src/io/export.ts` + `src/io/flows.ts` (inline media to base64 on
download); `src/io/serialize.ts` (comment/doc only); `src/sync/importBoard.ts` (accept
data-URL filemap → upload path); `src/sync/api.ts` (carry `key` param/Bearer on
mutating calls; treat 403 → lock look-only); `src/sync/client.ts` (send key on push,
handle 403); `src/sync/live.ts` (send key in WS hello; 4403/403 → look-only);
`src/ui/MainMenu.tsx`/`src/ui/Dialogs.tsx` ("Copy invite link"; look-only notice on
rejected edit); `src/sync/session.ts`/`Boot.tsx` (parse `?key=` from URL, hold in memory,
never in localStorage).

**Config/CI**: `package.json` (wrangler devDep, `deploy`/`dev:cf` scripts; express/
better-sqlite3/ws/fontkit moved to devDeps only in the final phase if self-host dropped),
`vite.config`/`wrangler.toml` (assets binding to `dist/`), `tsconfig` for worker types
(`@cloudflare/workers-types`), eslint/prettier include `worker/`, CI workflow gains a
`wrangler deploy` job (skipped until secrets set).

**Tests**: `worker/*.test.ts` — DO service tests via `cloudflare:test` pool
(`@cloudflare/vitest-pool-workers`); ported `server/api.test.ts`, `service.test.ts`,
`socket.test.ts`, `sync/convergence.test.ts` cases against the DO; e2e `server.spec.ts`
gets a `WORKERS_DEV` target.

**Docs**: `docs/security.md` (dual-secret model), `docs/plans/cloudflare-hosting-plan.md`
(this file), README deploy section.

## 7. Phases — each independently verifiable, repo stays green

Green = `npm run lint && npm run typecheck && npm run test && npm run build` pass on the
Node stack throughout; Worker code typechecks/tests from the phase it's added.

### Phase 0 — Static deploy + file-format hardening
Goal: a live `*.workers.dev` URL serving the drawing app (collab off), and a fully
self-contained `.chalana` export.
Scope: wrangler.toml + `worker/index.ts` serving static assets (SPA fallback for
`/s/*`); export inlines media as base64; import accepts data-URL FileMap; deploy job
(manual `wrangler deploy`, CLOUDFLARE_API_TOKEN present).
Acceptance: `wrangler deploy` → URL serves app; draw → download → wipe → upload →
identical scene incl. images; all Node tests/lint green.

### Phase 1 — Board DO + REST parity (collab via push, no sockets yet)
Goal: shared boards over HTTP on the Worker.
Scope: `worker/do/{board,service,schema}.ts`; all 9 REST routes DO-backed; dual-secret
mint/check; per-IP create rate limit; 403→look-only client handling; `?key=` plumbing.
Acceptance: vitest-pool-workers port of service/api tests green; two browsers on the
workers.dev URL see each other's edits after manual refresh/poll; keyed editor edits,
view-only visitor is rejected on writes; Node stack still green.

### Phase 2 — WebSocket collab (hibernation)
Goal: real-time parity with the Node server.
Scope: `worker/do/socket.ts` (SyncCore port + `acceptWebSocket` + attachments +
hibernation alarm); key on WS hello; idle-eviction alarm (7-day TTL) + 410 gone path.
Acceptance: ported socket/convergence tests green; two tabs edit live concurrently on
workers.dev; idle socket hibernates (no DO duration burn); evicted board returns 410 and
offers re-upload.

### Phase 3 — MCP on Workers
Goal: invited agents draw on hosted boards.
Scope: `worker/mcp.ts` (SDK transport if it runs, else JSON-RPC dispatch); tool modules
rewired to DO; auth = keyed URL or Bearer; view-only agent gets read tools only.
Acceptance: ported `mcp/http.test.ts` green; `npx chalanamaya-mcp` stdio bridge against
workers.dev executes a write tool end-to-end with an edit link, and is rejected without
a key; MCP over POST works from a remote client.

### Phase 4 — R2 media
Goal: hosted image/video/file upload + download.
Scope: R2 binding; `/files` + `/media/<key>` routes; sniff port; FileMap → r2key; import
writes decoded base64 to R2; eviction deletes objects.
Acceptance: upload image → renders on a second client; downloaded `.chalana` inlines it;
import restores it; media tests green.

### Phase 5 — Hardening, abuse controls, cleanup
Goal: production-grade for public free access.
Scope: rate limits tuned (create/import/ops), cap-exhaustion UX (mirror queue notice,
"board is read-only until tomorrow"), board-count LRU sweeper cron Worker, CSP/Host
allowlist final, `docs/security.md` update, README deploy docs; decide & either drop
`server/` Node deps or keep self-host; v2 in-app request/approve only if demanded.
Acceptance: soak — N boards, sustained edit traffic stays within free caps (checked via
CF analytics); `wrangler deploy` reproducible from CI; full green suite incl. e2e
against workers.dev.

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
- **Free-tier alarms**: CF notifications on Workers/DO/R2 usage thresholds; plan for a
  507-style "capacity" page when daily caps trip.

## 9. Open questions resolved / deferred

1. **TTL**: 7-day idle eviction + global LRU — boards are ephemeral, `.chalana` is the
   store. (Answers Q1.)
2. **MCP SDK on Workers**: try SDK first, hand-rolled JSON-RPC fallback — decided in
   Phase 3 with a 1-hour spike. (Q2.)
3. **Fonts**: approximate metrics + `needs_layout` correction; no fontkit on Workers. (Q3.)
4. **Approval UX**: v1 edit links; v2 in-app approve deferred to post-launch. (Q4.)
5. **Media**: R2 from Phase 4; Phase 0–3 media via remote links + inlined base64 only. (Q5.)
6. **Abuse**: per-IP create limit + existing per-board quotas + cap-exhaustion UX. (Q6.)
7. **Node server**: kept green through migration; drop-or-keep decided at Phase 5.
