# ChalanaMaya

ChalanaMaya is a hand-drawn-style whiteboard for sketching ideas, explaining plans, and arranging visual notes. It aims for familiar, easy drawing with its own colours, type, icons, and voice.

It is a React + TypeScript app served by a small Node server (Express, SQLite). Every board is a session at `/s/<id>`: opening `/` starts a new board, and the board is saved on the ChalanaMaya server (SQLite on disk), so it survives reloads and server restarts. Anyone with the board's address or id can open and change it. Tabs open on the same board stay in sync live over a WebSocket (`/api/sessions/<id>/socket`): adds, moves, deletes and layer order show up in the other tabs within a second, each tab keeps its own undo, and edits made offline are sent when the connection is back. An MCP server so agents (Claude, Devin, ChatGPT…) can draw on a session is being built — see the [agent canvas plan](docs/plans/agent-canvas.md).

## Run it

Needs Node.js 20 or newer.

```bash
npm install
npm run dev            # http://localhost:5183 with hot reload
npm run build && npm start   # production build, http://localhost:5183
```

Settings (port, data folder, allowed hosts, proxies, limits) and the server's API are in the [setup guide](docs/agents/setup.md), which also explains how agents will connect. Read [security](docs/security.md) before exposing the server beyond your machine.

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
