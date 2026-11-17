# Running ChalanaMaya and connecting agents

Status: the ChalanaMaya server runs, keeps every board, syncs open tabs live and has a built-in MCP server for agents (phases 1b–4 of the [agent canvas plan](../plans/agent-canvas.md)). Opening `/` starts a board at `/s/<id>`; the main menu copies the board link or id, and that id is all an agent needs. A board kept by the earlier browser-only version is offered for import on boards opened at the same address (`http://localhost:5183` by default; start once with `PORT=5184` for boards saved there).

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
| `POST /api/sessions/:id/files` | Upload a picture, GIF or video (PNG, JPEG, GIF or WebP up to 10 MB; MP4 or WebM up to 25 MB, `MAX_VIDEO_BYTES`; the bytes must match the type). |
| `POST /api/sessions/:id/links` | Add an https link to a picture, GIF or video (`{url, mime?, width?, height?}`); stored as a link, never fetched by the server. |
| `GET /api/sessions/:id/files/:fileId` | Download it (supports `Range`). |
| `DELETE /api/sessions/:id` | Delete the board. |

## Connecting agents

ChalanaMaya has a built-in MCP server. Agents such as Claude, Devin, ChatGPT or any MCP client connect once; after that they only need a **board id** (the 24 characters at the end of `/s/<id>`, or the whole board link) and a description of what to draw. Changes show up live in every open tab of that board, with a notice such as "Claude added 6 items · Show".

Two ways to connect:

- **Streamable HTTP:** `http://localhost:5183/mcp` (stateless: every `POST` stands alone, so a server restart never breaks a client; `GET` and `DELETE` answer 405; request bodies up to 16 MB).
- **stdio bridge** for desktop clients: `node /absolute/path/to/ChalanaMaya/dist-server/stdio.js` (built by `npm run build`; `npm run mcp:stdio` runs the same). It forwards everything to the server at `CHALANAMAYA_URL` (default `http://localhost:5183`) and never opens the database, so the server must be running (`npm start`). The bridge can start first: it answers the client at once, connects on the first request, reconnects after the server restarts and then tells the client the tools are available again. Writes without `agent_name` are labelled with the desktop client's name.

The MCP protocol's own "session" (the `Mcp-Session-Id` header) has nothing to do with the board `session_id`; ChalanaMaya does not use MCP sessions at all.

### Claude Desktop

Settings → Developer → Edit Config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "chalanamaya": {
      "command": "node",
      "args": ["/absolute/path/to/ChalanaMaya/dist-server/stdio.js"],
      "env": { "CHALANAMAYA_URL": "http://localhost:5183" }
    }
  }
}
```

Restart Claude Desktop, then say for example: "Draw a login flowchart on ChalanaMaya board `Xy3…` (paste the id)".

### Claude Code

```bash
claude mcp add --transport http chalanamaya http://localhost:5183/mcp
# or through the bridge:
claude mcp add chalanamaya -- node /absolute/path/to/ChalanaMaya/dist-server/stdio.js
```

The drawing guide is also a skill: copy `skills/chalanamaya/` into `~/.claude/skills/` (or the project's `.claude/skills/`).

### Cursor, VS Code, Windsurf and other MCP clients

Most clients take an HTTP server entry:

```json
{ "mcpServers": { "chalanamaya": { "url": "http://localhost:5183/mcp" } } }
```

or the same `command`/`args` as Claude Desktop for stdio.

### MCP Inspector and other browser-based clients

A browser page on another origin is refused unless its origin is listed: start the server with `ALLOWED_ORIGINS=http://localhost:6274 npm start`, then run `npx @modelcontextprotocol/inspector` and connect to `http://localhost:5183/mcp` (transport "Streamable HTTP"). `ALLOWED_ORIGINS` applies to `/mcp` only, never to the REST API or the board sockets.

### ChatGPT, Devin and other cloud agents

Cloud agents run on someone else's computer and cannot reach your `localhost`. ChalanaMaya has to be reachable over public HTTPS, for example through a short-lived tunnel:

```bash
npm start &
cloudflared tunnel --url http://localhost:5183          # prints https://<random>.trycloudflare.com
# restart with the public address so its host is accepted:
PUBLIC_URL=https://<random>.trycloudflare.com npm start
```

Then add `https://<random>.trycloudflare.com/mcp` as a remote MCP server (ChatGPT: Settings → Connectors / developer mode; Devin: Settings → MCP servers, transport HTTP). Anyone who has a board id can change that board, and the server has no sign-in: **treat a board link like a password** and stop the tunnel when you are done. See [security](../security.md).

### What agents can do

The tools, their inputs and errors are listed in [MCP tools](mcp-tools.md). The drawing guide (`skills/chalanamaya/SKILL.md`, also served as the `chalanamaya://guide` resource and the `chalanamaya_guide` prompt) teaches the coordinate system, spacing, colours and recipes. Agents can place pictures, animated GIFs and MP4/WebM videos with `place_media`, from an `upload_media` file id, from `data_base64` bytes, or from an https link (`source: {url}`). Uploaded media is drawn in the board and exported; links are shown live by the browser (without a referrer, never fetched by the server) and appear as a placeholder card in exports. Videos start muted and looping. Animated components arrive later and are refused with `kind_not_supported_yet`.

Board sync is not full collaboration: there are no accounts, cursors or presence; each item keeps its latest change; a person's undo never reverts an agent's change (an agent's **clear** shows a notice with **Restore**).
