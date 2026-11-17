# Running ChalanaMaya and connecting agents

Status: the ChalanaMaya server runs and keeps every board (phases 1b and 2 of the [agent canvas plan](../plans/agent-canvas.md)). Opening `/` starts a board at `/s/<id>`; the main menu copies the board link or id. The MCP endpoint that agents use arrives in phase 4, so agents cannot draw on a board yet; the sections below say what is already there. A board kept by the earlier browser-only version is offered for import on boards opened at the same address (`http://localhost:5183` by default; start once with `PORT=5184` for boards saved there).

## Run the server

Needs Node.js 20 or newer.

```bash
npm install
npm run dev        # app with hot reload, API, all on http://localhost:5183
# or, for normal use:
npm run build
npm start          # node dist-server/main.js, prints http://localhost:5183/
```

`npm start` listens on loopback only (`127.0.0.1` and `::1`) and always prints `localhost`; open `http://localhost:5183`, not `127.0.0.1` (a different address for the browser, with its own saved board). Boards and pictures are stored in `data/` (`chalanamaya.db` and `media/`). Start-up first runs a small database check (`npm run db:smoke` runs the same check on its own) and stops with a clear message if SQLite does not work or a setting is malformed.

If you used the older `vite preview` address (`http://localhost:5184`), start once with `PORT=5184 npm start` and open that address to reach the board saved there.

### Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `5183` | Port to listen on. |
| `HOST` | loopback | Address to listen on, for example `0.0.0.0` for the local network. Add the name or address others use to `ALLOWED_HOSTS`. |
| `DATA_DIR` | `./data` | Where the database and media files are kept. |
| `PUBLIC_URL` | — | The full public address when ChalanaMaya runs behind a tunnel or proxy, for example `https://board.example.com`. Its host is accepted automatically. |
| `ALLOWED_HOSTS` | — | Extra accepted `Host` names, comma separated, without scheme or path (`myboard.lan,192.168.1.20,fe80::1`). `localhost`, `127.0.0.1` and `[::1]` are always accepted. |
| `TRUST_PROXY` | off | Set when a reverse proxy sits in front: `loopback`, a hop count (`1`) or proxy addresses. Only then is `X-Forwarded-For` used for rate limits. |
| `ALLOWED_ORIGINS` | — | Full origins of browser-based MCP clients (for example `http://localhost:6274` for MCP Inspector). Applies to `/mcp` only. |
| `RATE_LIMITS` | `on` | `off` turns rate limits off. `RATE_LIMIT_SESSIONS` (30), `RATE_LIMIT_UPLOADS` (60) and `RATE_LIMIT_MCP` (600) set requests per minute per address. |
| `MAX_SESSIONS` | `10000` | Most boards on this server. |
| `MAX_TOTAL_MEDIA_BYTES` | 5 GiB | Total size of stored pictures and media. |
| `MAX_DB_BYTES` | 1 GiB | Database size. |
| `MAX_ELEMENTS` | `5000` | Items per board. |
| `MAX_SCENE_BYTES` | 10 MiB | Stored size of one board. |
| `MAX_SESSION_MEDIA_BYTES` | 200 MiB | Media per board. |
| `MAX_IMAGE_BYTES` | 10 MiB | One picture upload. |
| `SESSION_TTL_DAYS` | off | Remove boards not opened for this many days. |

Going over a storage limit returns HTTP 507 ("server is full") and leaves existing boards readable and unchanged.

## The REST API (used by the app)

All responses are JSON; errors look like `{"error": {"code": "...", "message": "..."}}`. Requests that change something must send the header `X-ChalanaMaya: 1` and must not come from another site.

```bash
curl -s http://localhost:5183/api/health
curl -s -X POST -H 'X-ChalanaMaya: 1' -H 'Content-Type: application/json' \
  -d '{"title":"Plan"}' http://localhost:5183/api/sessions     # {"session_id": "...", "url": "/s/..."}
curl -s http://localhost:5183/api/sessions/<id>/scene
```

| Route | What it does |
| --- | --- |
| `POST /api/sessions` | New board; returns its 24-character id. |
| `GET /api/sessions/:id` | Title, revision, item count, times. |
| `GET /api/sessions/:id/scene` | The whole board: items with layer keys and versions, board settings, file list, tombstones. |
| `POST /api/sessions/:id/ops` | A batch of changes (`{pushId, baseRev, ops}`, add `?atomic=1` for all-or-nothing). Every item is strictly validated; the answer lists the new revision, versions and any refused change. A repeated `pushId` is answered with the stored answer and `duplicate: true`. |
| `POST /api/sessions/:id/import` | A whole board in one step (`{importId, mode: "add" \| "replace", elements}`), saved as one revision or not at all. |
| `POST /api/sessions/:id/files` | Upload a picture (PNG, JPEG, GIF or WebP; the bytes must match the type). |
| `GET /api/sessions/:id/files/:fileId` | Download it (supports `Range`). |
| `DELETE /api/sessions/:id` | Delete the board. |

## Connecting agents (phase 4)

Agents such as Claude, Devin, ChatGPT or any MCP client will connect to `http://localhost:5183/mcp` (Streamable HTTP) or through the stdio bridge `node /absolute/path/to/ChalanaMaya/dist-server/stdio.js`, and only need a session id to draw. The endpoint is reserved and already protected by the host and Origin checks, but it does not answer MCP requests yet; this guide gets the exact client snippets when phase 4 ships.

Cloud agents cannot reach your `localhost`. To use one, ChalanaMaya has to be reachable from the internet (for example through a short-lived tunnel with `PUBLIC_URL` set). The session id is then the only protection: treat a board link like a password. See [security](../security.md).
