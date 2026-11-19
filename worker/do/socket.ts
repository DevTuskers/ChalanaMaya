/**
 * Live sync inside a board DO (plan §Phase 2): the `SocketCore` port of
 * `server/sync/socket.ts`. One DO instance is exactly one board, so there is
 * no `boards` map — peers are `state.getWebSockets()`. Per-socket state lives
 * in the WebSocket attachment, which survives hibernation; a quiet board
 * costs no DO duration.
 *
 * Keys (plan §security): a `hello` may carry the board's edit or owner key;
 * the DO stores it in the attachment and re-checks it on every push, so an
 * owner rotation cuts live writers off mid-session. Sockets without a key
 * stay view-only: they get `snapshot`/`changes` but `push` answers 403.
 */
import { z } from "zod";
import {
  clientMessageSchema,
  type ClientMessage,
  type RemoteOp,
  type ServerMessage,
} from "../../src/shared/protocol";
import type { ChangesEvent, BoardStore } from "./store";

const PUSHES_PER_SECOND = 50;
const HELLOS_PER_10S = 10;

const BROWSER = { kind: "browser" as const, name: "A browser" };

/** Per-socket state persisted through hibernation. */
interface SockState {
  /** hello received */
  ready: boolean;
  /** the raw edit/owner key from hello (re-checked on each push) */
  key: string | null;
  /** 1-second push window start */
  window: number;
  /** pushes inside the window */
  count: number;
  /** hello timestamps inside 10s */
  hellos: number[];
}

const fresh = (): SockState => ({ ready: false, key: null, window: 0, count: 0, hellos: [] });

export class SocketCore {
  // Explicit type keeps `new SocketCore` below the tsc instantiation-depth cap.
  private readonly schema: z.ZodType<ClientMessage> = clientMessageSchema(500);

  constructor(
    private readonly state: DurableObjectState,
    private readonly board: () => BoardStore,
  ) {}

  peers(): number {
    return this.state.getWebSockets().length;
  }

  private read(ws: WebSocket): SockState {
    const a = ws.deserializeAttachment() as SockState | null;
    return a ?? fresh();
  }

  private write(ws: WebSocket, s: SockState) {
    ws.serializeAttachment(s);
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket gone
    }
  }

  private fail(ws: WebSocket, code: string, message: string, pushId?: string, status = 400) {
    this.send(ws, { type: "error", code, status, message, ...(pushId ? { pushId } : {}) });
  }

  /** Broadcast a committed change to every ready socket but `skip`. */
  broadcast(ev: ChangesEvent, skip?: WebSocket) {
    const msg: ServerMessage = {
      type: "changes",
      fromRev: ev.fromRev,
      rev: ev.rev,
      ops: ev.ops as RemoteOp[],
      origin: ev.origin,
    };
    const files = this.board().filesFor(ev.ops);
    const withFiles: ServerMessage = files.length ? { ...msg, files } : msg;
    for (const ws of this.state.getWebSockets()) {
      if (ws === skip) continue;
      const s = this.read(ws);
      if (!s.ready) continue;
      this.send(ws, withFiles);
    }
  }

  /** Board deleted or evicted: tell every socket and close it (4404). */
  closeAll(code: string, message: string) {
    for (const ws of this.state.getWebSockets()) {
      this.send(ws, { type: "error", code, status: 404, message });
      try {
        ws.close(4404, "board deleted");
      } catch {
        // already gone
      }
    }
  }

  async onMessage(ws: WebSocket, data: string) {
    const now = Date.now();
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return this.fail(ws, "bad_request", "That message is not JSON.");
    }
    const parsed = this.schema.safeParse(raw);
    if (!parsed.success) {
      const pid = (raw as { pushId?: unknown } | null)?.pushId;
      return this.fail(
        ws,
        "bad_request",
        parsed.error.issues[0]?.message ?? "That message is not valid.",
        typeof pid === "string" ? pid : undefined,
      );
    }
    const msg = parsed.data;
    const s = this.read(ws);
    try {
      switch (msg.type) {
        case "ping":
          return this.send(ws, { type: "pong" });
        case "hello": {
          s.hellos = s.hellos.filter((h) => now - h < 10_000);
          s.hellos.push(now);
          if (s.hellos.length > HELLOS_PER_10S) {
            this.fail(ws, "rate_limited", "Too many hellos; reconnect later.", undefined, 429);
            ws.close(4429, "too many hellos");
            return;
          }
          if (msg.key && (await this.board().checkKey(msg.key, "edit"))) s.key = msg.key;
          else s.key = null;
          try {
            const since =
              msg.sinceRev !== undefined ? this.board().changesSince(msg.sinceRev) : null;
            if (since)
              this.send(ws, {
                type: "changes",
                fromRev: since.fromRev,
                rev: since.rev,
                ops: since.ops as RemoteOp[],
                ...(since.files.length ? { files: since.files } : {}),
                origin: BROWSER,
              });
            else this.send(ws, { type: "snapshot", ...this.board().snapshot() });
          } catch (e) {
            // deleting/gone board: close so the tab relearns state over REST
            // instead of sitting half-open on a dead board
            const code = (e as { code?: string })?.code;
            if (code === "deleting" || code === "session_not_found") {
              // 4404 is the client's terminal close code: no reconnect
              ws.close(4404, "board is gone");
              return;
            }
            throw e;
          }
          s.ready = true;
          this.write(ws, s);
          return;
        }
        case "push": {
          if (!s.ready) return this.fail(ws, "bad_request", "Say hello first.", msg.pushId);
          // per-push re-verify: an owner rotation revokes a live writer at once
          if (!s.key || !(await this.board().checkKey(s.key, "edit"))) {
            s.key = null;
            this.write(ws, s);
            return this.fail(
              ws,
              "forbidden",
              "This link cannot change the board. Ask the owner for the editing link.",
              msg.pushId,
              403,
            );
          }
          if (now - s.window >= 1000) {
            s.window = now;
            s.count = 0;
          }
          s.count += 1;
          if (s.count > PUSHES_PER_SECOND)
            return this.fail(
              ws,
              "rate_limited",
              "Too many changes at once; slow down.",
              msg.pushId,
              429,
            );
          const { ack, event } = this.board().apply(
            { pushId: msg.pushId, baseRev: msg.baseRev, ops: msg.ops, mirrored: msg.mirrored },
            { origin: BROWSER, atomic: false },
          );
          this.write(ws, s);
          this.send(ws, { type: "ack", ...ack });
          if (event) this.broadcast(event, ws);
          return;
        }
      }
    } catch (e) {
      const err = e as { status?: number; code?: string; message?: string };
      const pid = msg.type === "push" ? msg.pushId : undefined;
      const status = typeof err?.status === "number" ? err.status : 500;
      this.fail(
        ws,
        err?.code ?? "internal",
        status === 500 ? "Something went wrong on the server." : (err?.message ?? "Error."),
        pid,
        status,
      );
      if (status === 404) ws.close(4404, "board deleted");
    }
  }
}
