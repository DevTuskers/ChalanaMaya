/**
 * In-process fakes for the worker vitest project: DurableObjectState (with the
 * real-SQLite SqlStorage shim), R2, namespaces, assets, rate limits. The
 * worker fetch handler runs end-to-end over these — same code, same SQL, no
 * workerd runtime needed.
 */
import type { DurableObjectState } from "@cloudflare/workers-types";
import { BoardSession } from "../do/board";
import { BoardIndex } from "../do/index";
import type { Env } from "../env";
import { SqliteStorage } from "./sqlite";

class FakeStorage {
  sql = new SqliteStorage();
  transactionSync<T>(fn: () => T): T {
    return this.sql.db.transaction(fn)() as T;
  }
  private alarm: number | null = null;
  async deleteAll() {
    this.sql = new SqliteStorage();
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(t: number) {
    this.alarm = t;
  }
}

/** A hibernation-era WebSocket stand-in: attachment persists, send is recorded. */
export class FakeSocket {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private attachment: unknown = null;
  send(text: string) {
    this.sent.push(text);
  }
  close(code = 1000, reason = "") {
    this.closed = { code, reason };
  }
  serializeAttachment(a: unknown) {
    this.attachment = a;
  }
  deserializeAttachment() {
    return this.attachment;
  }
  /** everything the socket said, parsed */
  messages(): { type?: string }[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

class FakeState {
  readonly storage = new FakeStorage();
  readonly sockets: FakeSocket[] = [];
  constructor(readonly id: { name: string }) {}
  async blockConcurrencyWhile<T>(fn: () => Promise<T> | T): Promise<T> {
    return fn();
  }
  waitUntil(_p: Promise<unknown>) {}
  acceptWebSocket(ws: FakeSocket) {
    this.sockets.push(ws);
  }
  getWebSockets() {
    return this.sockets;
  }
}

export class FakeR2 {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array) {
    this.objects.set(key, value);
    return {};
  }
  async get(key: string) {
    const b = this.objects.get(key);
    if (!b) return null;
    return { body: new Response(b as unknown as BodyInit).body! };
  }
  async delete(keys: string | string[]) {
    for (const k of [keys].flat()) this.objects.delete(k);
  }
}

export const fakeEnv = (opts: { rateLimit?: number } = {}) => {
  const media = new FakeR2();
  const boards = new Map<string, BoardSession>();
  const index = new Map<string, BoardIndex>();
  const states = new Map<string, FakeState>();
  const env = {
    ASSETS: {
      fetch: async () =>
        new Response("<html><body>ChalanaMaya</body></html>", {
          headers: { "Content-Type": "text/html" },
        }),
    },
    BOARD: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: (id: { name: string }) => {
        if (!boards.has(id.name)) {
          const st = new FakeState(id);
          states.set(id.name, st);
          boards.set(id.name, new BoardSession(st as never as DurableObjectState, env));
        }
        // workerd wraps a string URL into a Request before DO fetch.
        const obj = boards.get(id.name)!;
        return {
          fetch: (r: Request | string, init?: RequestInit) =>
            obj.fetch(typeof r === "string" ? new Request(r, init) : r),
        };
      },
    },
    INDEX: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: (id: { name: string }) => {
        if (!index.has(id.name))
          index.set(id.name, new BoardIndex(new FakeState(id) as never as DurableObjectState, env));
        const obj = index.get(id.name)!;
        return {
          fetch: (r: Request | string, init?: RequestInit) =>
            obj.fetch(typeof r === "string" ? new Request(r, init) : r),
        };
      },
    },
    MEDIA: media,
    SESSION_CREATE: {
      _n: new Map<string, number>(),
      async limit({ key }: { key: string }) {
        const n = (this._n.get(key) ?? 0) + 1;
        this._n.set(key, n);
        return { success: n <= (opts.rateLimit ?? 30) };
      },
    },
  } as unknown as Env & {
    _boards: Map<string, BoardSession>;
    _states: Map<string, FakeState>;
  };
  (env as { _boards?: unknown; _states?: unknown })._boards = boards;
  (env as { _states?: unknown })._states = states;
  return env;
};

export const fakeCtx = (): ExecutionContext =>
  ({
    waitUntil: () => {},
    passThroughOnException: () => {},
  }) as unknown as ExecutionContext;
