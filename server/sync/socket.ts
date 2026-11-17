/**
 * Live sync over WebSocket (plan §3.6, phase 3). One socket per tab at
 * `/api/sessions/:id/socket`. A tab says `hello` (with the last rev it saw),
 * gets a `snapshot` or the `changes` since then, pushes ops and receives an
 * `ack` for each push; every committed batch is broadcast as `changes` to
 * every other socket of the board — never back to the socket that pushed it.
 *
 * REST pushes and imports (and, from phase 4, agent edits) go through the same
 * SessionService, whose "changes" event feeds the broadcast.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { Limits } from "../config";
import { ServiceError } from "../errors";
import { redactIds } from "../security/rateLimit";
import type { ChangesEvent, SessionService } from "../sessions/service";
import {
  SOCKET_PATH_RE,
  clientMessageSchema,
  type RemoteOp,
  type ServerMessage,
} from "../../src/shared/protocol";

const BROWSER = { kind: "browser" as const, name: "A browser" };

export interface SocketOptions {
  limits: Limits;
  /** most sockets one board accepts at once */
  maxPerBoard?: number;
  /** pushes one socket may send per second before it is told to slow down */
  pushesPerSecond?: number;
  /** how often the server checks the socket is still alive */
  heartbeatMs?: number;
}

interface Peer {
  ws: WebSocket;
  sessionId: string;
  ready: boolean;
  alive: boolean;
  window: number;
  count: number;
}

export interface SyncHub {
  /** true when the request was a board socket (handled or refused) */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** open sockets of a board (for tests and diagnostics) */
  peers(sessionId: string): number;
  close(): void;
}

const refuse = (socket: Duplex, status: string) =>
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

export const createSyncHub = (service: SessionService, opts: SocketOptions): SyncHub => {
  const maxPerBoard = opts.maxPerBoard ?? 50;
  const pushesPerSecond = opts.pushesPerSecond ?? 50;
  const schema = clientMessageSchema(opts.limits.maxOpsPerPush);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: opts.limits.opsBodyBytes + 4096,
    perMessageDeflate: false,
  });
  const boards = new Map<string, Set<Peer>>();
  /** the socket whose push is being applied right now (its own changes are not echoed) */
  let pushing: Peer | null = null;

  const send = (p: Peer, msg: ServerMessage) => {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify(msg));
  };

  const onChanges = (e: ChangesEvent) => {
    const peers = boards.get(e.sessionId);
    if (!peers) return;
    const msg: ServerMessage = {
      type: "changes",
      fromRev: e.fromRev,
      rev: e.rev,
      ops: e.ops as RemoteOp[],
      origin: e.origin,
    };
    let files: ServerMessage | null = null;
    for (const p of peers) {
      if (p === pushing || !p.ready) continue;
      if (!files) {
        const f = service.filesFor(e.sessionId, e.ops);
        files = f.length ? { ...msg, files: f } : msg;
      }
      send(p, files);
    }
  };
  service.events.on("changes", onChanges);

  const heartbeat = setInterval(() => {
    for (const peers of boards.values())
      for (const p of peers) {
        if (!p.alive) {
          p.ws.terminate();
          continue;
        }
        p.alive = false;
        p.ws.ping();
      }
  }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref();

  const fail = (p: Peer, code: string, message: string, pushId?: string, status = 400) =>
    send(p, { type: "error", code, status, message, ...(pushId ? { pushId } : {}) });

  const onMessage = (p: Peer, data: RawData) => {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return fail(p, "bad_request", "That message is not JSON.");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const pid = (raw as { pushId?: unknown } | null)?.pushId;
      return fail(
        p,
        "bad_request",
        parsed.error.issues[0]?.message ?? "That message is not valid.",
        typeof pid === "string" ? pid : undefined,
      );
    }
    const msg = parsed.data;
    try {
      switch (msg.type) {
        case "ping":
          return send(p, { type: "pong" });
        case "hello": {
          const since =
            msg.sinceRev !== undefined ? service.changesSince(p.sessionId, msg.sinceRev) : null;
          if (since)
            send(p, {
              type: "changes",
              fromRev: since.fromRev,
              rev: since.rev,
              ops: since.ops as RemoteOp[],
              ...(since.files.length ? { files: since.files } : {}),
              origin: BROWSER,
            });
          else send(p, { type: "snapshot", ...service.snapshot(p.sessionId) });
          p.ready = true;
          return;
        }
        case "push": {
          if (!p.ready) return fail(p, "bad_request", "Say hello first.", msg.pushId);
          const now = Date.now();
          if (now - p.window >= 1000) {
            p.window = now;
            p.count = 0;
          }
          p.count += 1;
          if (p.count > pushesPerSecond)
            return fail(p, "rate_limited", "Too many changes at once; slow down.", msg.pushId, 429);
          pushing = p;
          try {
            const { ack } = service.apply(
              p.sessionId,
              { pushId: msg.pushId, baseRev: msg.baseRev, ops: msg.ops, mirrored: msg.mirrored },
              { origin: BROWSER, atomic: false },
            );
            send(p, { type: "ack", ...ack });
          } finally {
            pushing = null;
          }
          return;
        }
      }
    } catch (e) {
      if (e instanceof ServiceError) {
        const pid = msg.type === "push" ? msg.pushId : undefined;
        fail(p, e.code, e.message, pid, e.status);
        if (e.status === 404) p.ws.close(4404, "board deleted");
        return;
      }
      console.error("socket message failed:", redactIds(String((e as Error).message)));
      fail(
        p,
        "internal",
        "Something went wrong on the server.",
        msg.type === "push" ? msg.pushId : undefined,
        500,
      );
    }
  };

  return {
    handleUpgrade(req, socket, head) {
      const url = (req.url ?? "").split("?")[0];
      const m = SOCKET_PATH_RE.exec(url);
      if (!m) return false;
      const sessionId = m[1];
      try {
        service.meta(sessionId);
      } catch {
        refuse(socket, "404 Not Found");
        return true;
      }
      const peers = boards.get(sessionId) ?? new Set<Peer>();
      if (peers.size >= maxPerBoard) {
        refuse(socket, "503 Service Unavailable");
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const p: Peer = { ws, sessionId, ready: false, alive: true, window: 0, count: 0 };
        peers.add(p);
        boards.set(sessionId, peers);
        ws.on("pong", () => (p.alive = true));
        ws.on("message", (data) => {
          p.alive = true;
          onMessage(p, data);
        });
        ws.on("error", () => ws.terminate());
        ws.on("close", () => {
          peers.delete(p);
          if (peers.size === 0) boards.delete(sessionId);
        });
      });
      return true;
    },
    peers: (sessionId) => boards.get(sessionId)?.size ?? 0,
    close() {
      clearInterval(heartbeat);
      service.events.off("changes", onChanges);
      for (const peers of boards.values()) for (const p of peers) p.ws.terminate();
      boards.clear();
      wss.close();
    },
  };
};
