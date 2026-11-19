# ChalanaMaya

ChalanaMaya is a hand-drawn-style whiteboard for sketching ideas, explaining plans, and arranging visual notes. It aims for familiar, easy drawing with its own colours, type, icons, and voice.

It is a React + TypeScript app served by a small Node server (Express, SQLite). Every board is a session at `/s/<id>`: opening `/` starts a new board, and the board is saved on the ChalanaMaya server (SQLite on disk), so it survives reloads and server restarts. Anyone with the board's address or id can open and change it. Tabs open on the same board stay in sync live over a WebSocket (`/api/sessions/<id>/socket`): adds, moves, deletes and layer order show up in the other tabs within a second, each tab keeps its own undo, and edits made offline are sent when the connection is back. A built-in MCP server (`/mcp`, plus a stdio bridge for desktop clients) lets agents such as Claude, Devin, ChatGPT or any MCP client draw on a board: once connected, an agent needs only the board id. Their changes show up live in the open tabs. Boards can also hold animated GIFs and MP4/WebM videos (uploaded, pasted, dropped or placed by an agent with `place_media`), which play, move, resize, rotate and sync like any item, and https links to pictures, GIFs or videos, which the browser shows live (the server never fetches them; exports show a placeholder card). Animated CSS components can be added too: eight built-in presets (pulse, spinner, typing dots, progress bar, shimmer card, moving text, bouncing arrow, colour wave) or your own HTML and CSS (20 KB each, no scripts, event attributes, outside resources or SVG `<animate>`), from **Add animated component…** in the main menu or by an agent. They run in a sandboxed frame with no scripts and a strict content policy, stay see-through and readable in both themes, pause under reduced motion, and PNG/SVG exports show a still card with a picture of the preset. **Delete this board…** in the main menu removes a board and its media from the server for good; open tabs are told at once. Empty boards older than 24 hours are cleaned up. See [connecting agents](docs/agents/setup.md#connecting-agents), the [MCP tools](docs/agents/mcp-tools.md) and the agent skill in [`skills/chalanamaya/`](skills/chalanamaya/SKILL.md).

## Run it

Needs Node.js 20 or newer.

```bash
npm install
npm run dev            # http://localhost:5183 with hot reload
npm run build && npm start   # production build, http://localhost:5183
PORT=5300 npm start          # another port
```

Connect an agent over MCP (Streamable HTTP) at `http://localhost:5183/mcp`, for example with Claude Code:

```bash
claude mcp add --transport http chalanamaya http://localhost:5183/mcp
```

Desktop clients that only speak stdio run the bridge (`npm run mcp:stdio`, or `node dist-server/stdio.js` with `CHALANAMAYA_URL=http://localhost:5183`). Then ask the agent to draw on a board by giving it the board's id or address, for example "put this video on board `<id>` next to the diagram". Details for Claude Desktop, Devin, ChatGPT and other clients are in the [setup guide](docs/agents/setup.md#connecting-agents).

Settings (port, data folder, allowed hosts, proxies, limits) and the server's API are in the [setup guide](docs/agents/setup.md), which also explains how agents connect. Read [security](docs/security.md) before exposing the server beyond your machine.

## Host it on Cloudflare

ChalanaMaya also runs fully serverless on Cloudflare: the static app is served by Workers static assets, every board is a SQLite Durable Object (live sync over hibernating WebSockets included), media goes to R2, and `POST /mcp` answers the same 17 MCP tools with the same key rules — read tools are open to anyone with the board link, write tools need the board's edit or owner key (`Authorization: Bearer` or `#key=` in the board URL). Board links carry the view id plus `#key=`/`#owner=` fragments; see [docs/security.md](docs/security.md#cloudflare-workers).

Deploy needs the account id in `wrangler.toml` and a Workers API token:

```bash
CLOUDFLARE_API_TOKEN=… npx wrangler deploy    # → https://<name>.workers.dev
wrangler tail chalanamaya                    # live logs
```

`.github/workflows/deploy.yml` deploys on every push to `main` (needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets). The Node server stays the dev/test/self-host path; both hosts share the same `src/` logic.

## Checks

```bash
npm run lint
npm run typecheck      # app and server
npm test               # Vitest: app and server projects (npm run test:app / test:server)
npm run db:smoke       # SQLite check
npm run build
npm run test:e2e       # Playwright against the built server on port 5184
```

Start with the [documentation index](docs/README.md).
