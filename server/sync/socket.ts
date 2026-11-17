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
  /** most sockets the whole server accepts at once */
  maxSockets?: number;
  /** pushes one socket may send per second before it is told to slow down */
  pushesPerSecond?: number;
  /** hellos one socket may send per 10 s (each one costs a snapshot or a delta) */
  hellosPer10s?: number;
  /** how often the server checks the socket is still alive */
  heartbeatMs?: number;
  /** clock (tests) */
  now?: () => number;
}

/** One connected tab, independent of the transport. */
export interface SyncConn {
  /** a message from the tab (raw JSON text) */
  receive(data: string): void;
  /** the tab answered a heartbeat */
  pong(): void;
  /** the transport closed */
  disconnect(): void;
}

/** What the core needs from a transport. */
export interface SyncTransport {
  send(text: string): void;
  close(code: number, reason: string): void;
  /** liveness check; the transport answers with `conn.pong()` */
  ping?(): void;
  terminate?(): void;
}

interface Peer {
  t: SyncTransport;
  sessionId: string;
  ready: boolean;
  alive: boolean;
  window: number;
  count: number;
  hellos: number[];
}

/**
 * The sync protocol without WebSocket: the socket hub feeds it, and the
 * convergence test drives it directly against a real SessionService.
 */
export interface SyncCore {
  /** refused (404 missing board, 503 board or server full) or a live connection */
  connect(sessionId: string, t: SyncTransport): SyncConn | { refused: 404 | 503 };
  /** true when another socket may join this board right now */
  admits(sessionId: string): 404 | 503 | true;
  peers(sessionId: string): number;
  total(): number;
  /** heartbeat round: drops transports that did not answer the last one */
  sweep(): void;
  close(): void;
}

export const createSyncCore = (service: SessionService, opts: SocketOptions): SyncCore => {
  const maxPerBoard = opts.maxPerBoard ?? 50;
  const maxSockets = opts.maxSockets ?? 2000;
  const pushesPerSecond = opts.pushesPerSecond ?? 50;
  const hellosPer10s = opts.hellosPer10s ?? 10;
  const now = opts.now ?? Date.now;
  const schema = clientMessageSchema(opts.limits.maxOpsPerPush);
  const boards = new Map<string, Set<Peer>>();
  let total = 0;
  /** the socket whose push is being applied right now (its own changes are not echoed) */
  let pushing: Peer | null = null;

  const send = (p: Peer, msg: ServerMessage) => p.t.send(JSON.stringify(msg));

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

  const fail = (p: Peer, code: string, message: string, pushId?: string, status = 400) =>
    send(p, { type: "error", code, status, message, ...(pushId ? { pushId } : {}) });

  const onMessage = (p: Peer, data: string) => {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
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
          // every hello costs a snapshot or a delta: a client that keeps
          // saying it is told off and dropped (a well-behaved one says it once
          // per connection)
          const t = now();
          p.hellos = p.hellos.filter((h) => t - h < 10_000);
          p.hellos.push(t);
          if (p.hellos.length > hellosPer10s) {
            fail(p, "rate_limited", "Too many hellos; reconnect later.", undefined, 429);
            p.t.close(4429, "too many hellos");
            return;
          }
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
          const t = now();
          if (t - p.window >= 1000) {
            p.window = t;
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
        if (e.status === 404) p.t.close(4404, "board deleted");
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

  const admits = (sessionId: string): 404 | 503 | true => {
    try {
      service.meta(sessionId);
    } catch {
      return 404;
    }
    if (total >= maxSockets) return 503;
    if ((boards.get(sessionId)?.size ?? 0) >= maxPerBoard) return 503;
    return true;
  };

  return {
    admits,
    connect(sessionId, t) {
      const ok = admits(sessionId);
      if (ok !== true) return { refused: ok };
      const peers = boards.get(sessionId) ?? new Set<Peer>();
      const p: Peer = { t, sessionId, ready: false, alive: true, window: 0, count: 0, hellos: [] };
      peers.add(p);
      boards.set(sessionId, peers);
      total += 1;
      let gone = false;
      return {
        receive(data) {
          if (gone) return;
          p.alive = true;
          onMessage(p, data);
        },
        pong: () => void (p.alive = true),
        disconnect() {
          if (gone) return;
          gone = true;
          total -= 1;
          peers.delete(p);
          if (peers.size === 0) boards.delete(sessionId);
        },
      };
    },
    peers: (sessionId) => boards.get(sessionId)?.size ?? 0,
    total: () => total,
    sweep() {
      for (const peers of boards.values())
        for (const p of peers) {
          if (!p.alive) {
            p.t.terminate?.();
            continue;
          }
          p.alive = false;
          p.t.ping?.();
        }
    },
    close() {
      service.events.off("changes", onChanges);
      for (const peers of boards.values()) for (const p of peers) p.t.terminate?.();
      boards.clear();
      total = 0;
    },
  };
};

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
  const core = createSyncCore(service, opts);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: opts.limits.opsBodyBytes + 4096,
    perMessageDeflate: false,
  });
  const heartbeat = setInterval(() => core.sweep(), opts.heartbeatMs ?? 30_000);
  heartbeat.unref();

  return {
    handleUpgrade(req, socket, head) {
      const url = (req.url ?? "").split("?")[0];
      const m = SOCKET_PATH_RE.exec(url);
      if (!m) return false;
      const sessionId = m[1];
      const ok = core.admits(sessionId);
      if (ok !== true) {
        refuse(socket, ok === 404 ? "404 Not Found" : "503 Service Unavailable");
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const conn = core.connect(sessionId, {
          send: (text) => {
            if (ws.readyState === ws.OPEN) ws.send(text);
          },
          close: (code, reason) => ws.close(code, reason),
          ping: () => ws.ping(),
          terminate: () => ws.terminate(),
        });
        if ("refused" in conn) {
          // the board filled up (or was deleted) during the handshake
          ws.close(conn.refused === 404 ? 4404 : 1013, "refused");
          return;
        }
        ws.on("pong", () => conn.pong());
        ws.on("message", (data: RawData) => conn.receive(data.toString()));
        ws.on("error", () => ws.terminate());
        ws.on("close", () => conn.disconnect());
      });
      return true;
    },
    peers: (sessionId) => core.peers(sessionId),
    close() {
      clearInterval(heartbeat);
      core.close();
      wss.close();
    },
  };
};
