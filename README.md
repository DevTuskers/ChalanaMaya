# ChalanaMaya

ChalanaMaya is a hand-drawn-style whiteboard for sketching ideas, explaining plans, and arranging visual notes. It aims for familiar, easy drawing with its own colours, type, icons, and voice.

It is a React + TypeScript app served by a small Node server (Express, SQLite). Today the board in the browser is saved in the browser; board sessions at `/s/<id>` that live on the server, and an MCP server so agents (Claude, Devin, ChatGPT…) can draw on a session, are being built — see the [agent canvas plan](docs/plans/agent-canvas.md).

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
