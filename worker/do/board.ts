/**
 * BoardSession: one Durable Object per ChalanaMaya board (plan §3.2). The DO
 * is addressed by the board's public `viewId` (the `/s/<viewId>` address),
 * holds the whole board in its SQLite storage, keeps media bytes in R2, and
 * enforces the three-secret model:
 *
 *  - viewId — read + live view (the DO name itself is unguessable);
 *  - editKey (`#key=` fragment or `Authorization: Bearer`) — every mutating
 *    route;
 *  - ownerKey (`#owner=` fragment or `Authorization: Bearer`) — rotation and
 *    delete; it also edits.
 *
 * `GET /socket` upgrades to a live view/edit socket (`SocketCore`, phase 2).
 */
import type { DurableObjectState } from "@cloudflare/workers-types";
import type { Env } from "../env";
import { ServiceError } from "../../server/errors";
import { pushSchema, importSchema } from "../../src/shared/protocol";
import { json } from "../http";
import { migrate } from "./schema";
import { BoardStore, type ChangeOrigin } from "./store";
import { SocketCore } from "./socket";
import { handleBoardMcp } from "../mcp";

const json16k = async (req: Request) => {
  const text = await req.text();
  if (text.length > 2 * 1024 * 1024)
    throw new ServiceError(413, "too_large", "The request body is too large.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ServiceError(400, "bad_json", "The request body is not JSON.");
  }
};

/** `Authorization: Bearer <key>` → the key, or null. */
const bearer = (req: Request): string | null => {
  const h = req.headers.get("Authorization");
  if (!h || !h.startsWith("Bearer ")) return null;
  const k = h.slice(7).trim();
  return k || null;
};

const forbidden = () =>
  new ServiceError(
    403,
    "forbidden",
    "This link cannot change the board. Ask the owner for the editing link.",
  );

// Not `extends DurableObject`: the cloudflare:workers base-class types hang
// tsc; a Durable Object entrypoint only needs a constructor + fetch.
export class BoardSession {
  private store: BoardStore | null = null;
  private readonly sock: SocketCore;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    // Asserted ctor keeps `new SocketCore` below tsc's instantiation-depth
    // cap (BoardStore's full type is too deep to unify inside the class).
    const Sock = SocketCore as unknown as new (
      s: DurableObjectState,
      b: () => BoardStore,
    ) => SocketCore;
    this.sock = new Sock(state, () => this.board());
  }

  private board(): BoardStore {
    if (!this.store) {
      migrate(this.state.storage.sql);
      const id = this.state.id.name;
      if (!id) throw new ServiceError(500, "do_unnamed", "Board objects must be named by viewId.");
      this.store = new BoardStore(this.state.storage.sql, id, this.env.MEDIA, {
        // sql.exec bans BEGIN/COMMIT in Durable Object SQLite
        tx: (fn) => this.state.storage.transactionSync(fn),
      });
    }
    return this.store;
  }

  private async requireKey(req: Request, kind: "edit" | "owner") {
    const key = bearer(req);
    if (!key || !(await this.board().checkKey(key, kind))) throw forbidden();
  }

  async fetch(req: Request): Promise<Response> {
    try {
      return await this.route(req);
    } catch (e) {
      if (e instanceof ServiceError)
        return json({ error: { code: e.code, message: e.message } }, e.status);
      throw e;
    }
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin: ChangeOrigin = { kind: "browser", name: "browser" };

    // Called once by the worker right after the DO id is minted.
    if (path === "/_create" && req.method === "POST") {
      if (this.board().exists)
        return json(
          { error: { code: "session_exists", message: "This board already exists." } },
          409,
        );
      const body = (await req.json().catch(() => ({}))) as { title?: string };
      const { editKey, ownerKey } = await this.board().create(
        typeof body.title === "string" ? body.title : "",
      );
      return json({ editKey, ownerKey }, 201);
    }

    // Session-scoped MCP JSON-RPC (phase 3): read tools are free, write
    // tools need the board key; live changes broadcast to open tabs.
    if (path === "/mcp" && req.method === "POST") {
      const base = req.headers.get("x-cm-base") ?? `${url.protocol}//${url.host}`;
      return await handleBoardMcp(req, this.board(), this.sock, base);
    }

    // Board routes arrive as /api/sessions/<viewId>/<rest>.
    const rest = path.replace(/^\/api\/sessions\/[A-Za-z0-9_-]{24}\/?/, "");

    switch (true) {
      case rest === "" && req.method === "GET":
        return json(this.board().meta());

      case rest === "scene" && req.method === "GET":
        // `keyed` marks this as a keyed host, so a keyless open goes look-only.
        return json({ ...this.board().snapshot({ markOpened: true }), keyed: true });

      case rest === "ops" && req.method === "POST": {
        await this.requireKey(req, "edit");
        const raw = await json16k(req);
        const parsed = pushSchema(500).safeParse(raw);
        if (!parsed.success)
          throw new ServiceError(
            400,
            "bad_push",
            parsed.error.issues[0]?.message ?? "invalid push",
          );
        const atomic = url.searchParams.get("atomic") === "1";
        const r = this.board().apply(parsed.data, { origin, atomic });
        if (r.event) this.sock.broadcast(r.event);
        return json(r.ack);
      }

      case rest === "import" && req.method === "POST": {
        await this.requireKey(req, "edit");
        const text = await req.text();
        if (text.length > 12 * 1024 * 1024)
          throw new ServiceError(413, "too_large", "The import body is too large.");
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new ServiceError(400, "bad_json", "The request body is not JSON.");
        }
        const parsed = importSchema.safeParse(raw);
        if (!parsed.success)
          throw new ServiceError(
            400,
            "bad_import",
            parsed.error.issues[0]?.message ?? "invalid import",
          );
        const r = this.board().importScene(parsed.data, origin);
        if (r.event) this.sock.broadcast(r.event);
        return json(r.ack);
      }

      case rest === "files" && req.method === "POST": {
        await this.requireKey(req, "edit");
        const bytes = new Uint8Array(await req.arrayBuffer());
        const f = await this.board().addFile(bytes, req.headers.get("Content-Type") ?? undefined);
        return json(
          {
            file_id: f.id,
            url: f.url,
            mime: f.mime,
            size: f.size,
            width: f.width,
            height: f.height,
            duration_ms: f.durationMs,
            source: "upload",
          },
          201,
        );
      }

      case rest === "links" && req.method === "POST": {
        await this.requireKey(req, "edit");
        const raw = (await json16k(req)) as {
          url?: unknown;
          mime?: unknown;
          width?: unknown;
          height?: unknown;
        };
        if (typeof raw?.url !== "string" || typeof raw?.mime !== "string")
          throw new ServiceError(400, "bad_link", "A link needs url and mime.");
        const dim = (v: unknown) => (typeof v === "number" ? v : undefined);
        const f = await this.board().addRemoteFile(raw.url, raw.mime, {
          width: dim(raw.width),
          height: dim(raw.height),
        });
        return json(
          {
            file_id: f.id,
            url: f.url,
            mime: f.mime,
            size: 0,
            width: f.width,
            height: f.height,
            duration_ms: null,
            source: "remote",
          },
          201,
        );
      }

      case /^files\/[A-Za-z0-9_-]{1,64}$/.test(rest) && req.method === "GET": {
        const fileId = rest.slice("files/".length);
        const { file, key } = this.board().fileForDownload(fileId);
        const obj = await this.env.MEDIA.get(key);
        if (!obj) throw new ServiceError(404, "file_not_found", "This file is gone.");
        return new Response(obj.body, {
          headers: {
            "Content-Type": file.mime,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cache-Control": "private, max-age=31536000, immutable",
            "Cross-Origin-Resource-Policy": "same-origin",
          },
        });
      }

      case rest === "" && req.method === "DELETE": {
        await this.requireKey(req, "owner");
        this.sock.closeAll("session_not_found", "This board was deleted.");
        await this.board().deleteSession();
        // Owner deletes are 404s, not 410 evictions: drop the index row so the
        // sweeper never tombstones this board.
        await this.env.INDEX.get(this.env.INDEX.idFromName("fleet"))
          .fetch("https://index/remove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: this.state.id.name }),
          })
          .catch(() => new Response()); // best effort; the sweep 404-evicts anyway
        return json({ ok: true });
      }

      case rest === "keys/rotate" && req.method === "POST": {
        await this.requireKey(req, "owner");
        const { editKey, ownerKey } = await this.board().rotateKeys();
        const id = this.state.id.name!;
        return json({
          invite_url: `/s/${id}#key=${editKey}`,
          owner_url: `/s/${id}#owner=${ownerKey}`,
        });
      }

      // Fleet eviction (BoardIndex alarm): drop the board and its storage.
      case path === "/_evict" && req.method === "POST": {
        if (!this.board().exists) return json({ evicted: true });
        this.sock.closeAll("session_not_found", "This board was deleted.");
        await this.board().deleteSession();
        await this.state.storage.deleteAll();
        return json({ evicted: true });
      }

      case rest === "socket": {
        if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
          return json(
            { error: { code: "upgrade_required", message: "This route is a WebSocket." } },
            426,
          );
        if (this.sock.peers() >= MAX_PEERS)
          return json(
            { error: { code: "capacity", message: "This board is full of live editors." } },
            503,
          );
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.state.acceptWebSocket(server);
        server.serializeAttachment({
          ready: false,
          key: null,
          window: 0,
          count: 0,
          hellos: [],
        });
        return new Response(null, { status: 101, webSocket: client });
      }

      default:
        throw new ServiceError(404, "not_found", "There is no route at this address.");
    }
  }

  /** Socket fan-in (hibernation wakes the DO on each message). */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return ws.close(1003, "text only");
    try {
      await this.sock.onMessage(ws, message);
    } catch (e) {
      if (e instanceof ServiceError && e.status === 404) ws.close(4404, "board deleted");
      else ws.close(1011, "socket error");
    }
  }

  webSocketClose() {}
  webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "socket error");
    } catch {
      // already gone
    }
  }

  /** Idle-eviction alarm (phase 2): cleans push_log + tombstones. */
  async alarm() {
    if (this.store) this.store.maintenance();
  }
}

const MAX_PEERS = 50;
