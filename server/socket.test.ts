/**
 * Phase 3 integration tests: the live socket against a real server on a random
 * port (plan §3.6, §8): snapshot on hello, ack to the pusher and `changes` to
 * everyone else, duplicate pushes, reconnect with `sinceRev`, refusals, and
 * two real SyncClients (browser code) converging through the socket.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { newPushId } from "../src/shared/ids";
import type { ServerMessage } from "../src/shared/protocol";
import type { SceneElement } from "../src/scene/types";
import { createHttpApi } from "../src/sync/api";
import { SyncClient } from "../src/sync/client";
import { LiveChannel } from "../src/sync/live";
import { PendingMirror } from "../src/sync/mirror";
import type { StorageLike } from "../src/io/autosave";
import { Store } from "../src/store/store";
import { api, keys, put, rect, startServer, upgradeStatus, type TestServer } from "./test/helpers";

let srv: TestServer;
let A: ReturnType<typeof api>;
beforeAll(async () => {
  srv = await startServer();
  A = api(srv);
});
afterAll(() => srv.close());

const wsUrl = (sid: string) => `ws://localhost:${srv.port}/api/sessions/${sid}/socket`;

/** A raw socket that records every server message. */
const open = async (sid: string, headers: Record<string, string> = {}) => {
  const ws = new WebSocket(wsUrl(sid), { headers });
  const msgs: ServerMessage[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString()) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = async (pred: (m: ServerMessage) => boolean, ms = 3000) => {
    const t0 = Date.now();
    for (;;) {
      const i = msgs.findIndex(pred);
      if (i >= 0) return msgs.splice(i, 1)[0];
      if (Date.now() - t0 > ms)
        throw new Error(`no message after ${ms} ms: ${JSON.stringify(msgs)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return {
    ws,
    msgs,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    next,
    of: <T extends ServerMessage["type"]>(type: T) =>
      next((m) => m.type === type) as Promise<Extract<ServerMessage, { type: T }>>,
    close: () => ws.close(),
  };
};
const quiet = () => new Promise((r) => setTimeout(r, 150));

describe("live socket protocol", () => {
  it("hello gets a snapshot; a push is acked to the pusher and broadcast to others only", async () => {
    const sid = await A.createSession();
    const [k1] = keys(1);
    const a = await open(sid);
    const b = await open(sid);
    a.send({ type: "hello", clientId: "client-a-1" });
    b.send({ type: "hello", clientId: "client-b-1" });
    expect((await a.of("snapshot")).rev).toBe(0);
    await b.of("snapshot");
    const el = rect();
    const pushId = newPushId();
    a.send({ type: "push", pushId, baseRev: 0, ops: [put(el, k1)] });
    const ack = await a.of("ack");
    expect(ack).toMatchObject({ pushId, rev: 1, versions: { [el.id]: 1 } });
    const ch = await b.of("changes");
    expect(ch).toMatchObject({ fromRev: 0, rev: 1, origin: { kind: "browser" } });
    expect(ch.ops).toEqual([{ t: "put", el, idx: k1, version: 1, needsLayout: false }]);
    await quiet();
    expect(a.msgs.filter((m) => m.type === "changes")).toEqual([]);
    // a repeated pushId gets the stored ack and is not broadcast again
    a.send({ type: "push", pushId, baseRev: 0, ops: [put(el, k1)] });
    expect(await a.of("ack")).toMatchObject({ pushId, rev: 1, duplicate: true });
    await quiet();
    expect(b.msgs.filter((m) => m.type === "changes")).toEqual([]);
    a.close();
    b.close();
  });

  it("REST pushes and deletes reach every socket, with versions for put and del", async () => {
    const sid = await A.createSession();
    const a = await open(sid);
    a.send({ type: "hello", clientId: "client-a-2" });
    await a.of("snapshot");
    const el = rect();
    await A.push(sid, [put(el, "a0")]);
    const c1 = await a.of("changes");
    expect(c1.ops[0]).toMatchObject({ t: "put", version: 1 });
    await A.push(sid, [{ t: "del", id: el.id, baseVersion: 1 }]);
    const c2 = await a.of("changes");
    expect(c2.ops).toEqual([{ t: "del", id: el.id, version: 2 }]);
    a.close();
  });

  it("reconnect with sinceRev gets only what changed, tombstones included", async () => {
    const sid = await A.createSession();
    const [k1, k2] = keys(2);
    const x = rect();
    const y = rect();
    await A.push(sid, [put(x, k1), put(y, k2)]);
    const a = await open(sid);
    a.send({ type: "hello", clientId: "client-a-3", sinceRev: 1 });
    const none = await a.of("changes");
    expect(none).toMatchObject({ fromRev: 1, rev: 1, ops: [] });
    a.close();
    await A.push(sid, [{ t: "del", id: x.id, baseVersion: 1 }]);
    await A.push(sid, [put({ ...y, x: 99 }, k2, 1)]);
    const b = await open(sid);
    b.send({ type: "hello", clientId: "client-b-3", sinceRev: 1 });
    const ch = await b.of("changes");
    expect(ch).toMatchObject({ fromRev: 1, rev: 3 });
    expect(ch.ops).toContainEqual({ t: "del", id: x.id, version: 2 });
    expect(ch.ops).toContainEqual(
      expect.objectContaining({ t: "put", version: 2, el: expect.objectContaining({ x: 99 }) }),
    );
    expect(ch.ops.find((o) => o.t === "settings")).toBeTruthy();
    // a rev the board never had: full snapshot
    b.send({ type: "hello", clientId: "client-b-3", sinceRev: 50 });
    const snap = await b.of("snapshot");
    expect(snap.rev).toBe(3);
    expect(snap.tombstones).toEqual([{ id: x.id, version: 2 }]);
    b.close();
  });

  it("refuses bad messages, pushes before hello, unknown boards and other sites", async () => {
    const sid = await A.createSession();
    const a = await open(sid);
    a.send({ type: "push", pushId: newPushId(), baseRev: 0, ops: [] });
    expect(await a.of("error")).toMatchObject({ code: "bad_request" });
    a.ws.send("not json");
    expect(await a.of("error")).toMatchObject({ code: "bad_request" });
    a.send({ type: "hello", clientId: "client-a-4" });
    await a.of("snapshot");
    const pid = newPushId();
    a.send({ type: "push", pushId: pid, baseRev: 0, ops: [put({ type: "rectangle" }, "a0")] });
    const ack = await a.of("ack");
    expect(ack.rejected[0]).toMatchObject({ reason: "invalid" });
    a.send({ type: "nope" });
    expect(await a.of("error")).toMatchObject({ code: "bad_request" });
    a.close();
    expect(await upgradeStatus(srv.port, `/api/sessions/${"x".repeat(24)}/socket`)).toBe(404);
    expect(
      await upgradeStatus(srv.port, `/api/sessions/${sid}/socket`, {
        Origin: "https://evil.example",
      }),
    ).toBe(403);
    expect(await upgradeStatus(srv.port, `/api/sessions/${sid}/nope`)).toBe(404);
  });

  it("answers ping with pong", async () => {
    const sid = await A.createSession();
    const a = await open(sid);
    a.send({ type: "ping" });
    await a.of("pong");
    a.close();
  });
});

// ------------------------------------------------------------ real clients

const memory = (): StorageLike => {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

/** A tab: Store + SyncClient + LiveChannel over a real socket. */
const tab = async (sid: string) => {
  const http = createHttpApi(srv.base);
  const snap = await http.scene(sid);
  const store = new Store();
  store.sessionMode = true;
  store.set({ elements: snap.elements.map((e) => e.el) });
  const client = new SyncClient(
    sid,
    http,
    {
      scene: () => ({
        elements: store.get().elements,
        settings: {
          viewBackgroundColor: store.get().viewBackgroundColor,
          gridEnabled: store.get().gridEnabled,
          title: "",
        },
      }),
      replaceElements: (elements) => store.set({ elements }),
      applyRemote: (elements, change, settings) =>
        store.applyRemote(elements, change, {
          ...(settings?.viewBackgroundColor
            ? { viewBackgroundColor: settings.viewBackgroundColor }
            : {}),
          ...(settings?.gridEnabled !== undefined ? { gridEnabled: settings.gridEnabled } : {}),
        }),
      status: () => {},
      protection: () => {},
      notice: () => {},
      takeLayerMoves: () => {
        const ids = [...store.layerMoves];
        store.layerMoves.clear();
        return ids;
      },
    },
    new PendingMirror(memory(), sid),
    {
      ...snap,
      settings: {
        viewBackgroundColor: snap.settings.viewBackgroundColor ?? store.get().viewBackgroundColor,
        gridEnabled: snap.settings.gridEnabled ?? false,
      },
    },
  );
  store.keyOf = (id) => client.keyOf(id);
  store.onSceneChange = () => client.schedule();
  store.onCommit = () => client.flush();
  const live = new LiveChannel(
    client,
    wsUrl(sid),
    null,
    WebSocket as unknown as new (u: string) => globalThis.WebSocket,
  );
  live.start();
  await until(() => client.connected);
  return { store, client, live, close: () => live.dispose() };
};

const until = async (f: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const ids = (els: readonly SceneElement[]) => els.map((e) => e.id);

describe("two SyncClients over the socket", () => {
  it("see each other's adds, edits, layer order and deletes, and the server agrees", async () => {
    const sid = await A.createSession();
    const t1 = await tab(sid);
    const t2 = await tab(sid);
    const a = rect();
    const b = rect();
    t1.store.commit([a, b]);
    await until(() => t2.store.get().elements.length === 2);
    expect(ids(t2.store.get().elements)).toEqual([a.id, b.id]);
    // t2 brings a to the front
    t2.store.commit([b, a], {}, new Set([a.id]));
    await until(() => ids(t1.store.get().elements)[1] === a.id);
    // t1 recolours b while t2 moves a: both kept
    t1.store.commit(
      t1.store.get().elements.map((e) => (e.id === b.id ? { ...e, strokeColor: "#e03131" } : e)),
    );
    t2.store.commit(t2.store.get().elements.map((e) => (e.id === a.id ? { ...e, x: 500 } : e)));
    await t1.client.settle();
    await t2.client.settle();
    await until(
      () =>
        JSON.stringify(t1.store.get().elements) === JSON.stringify(t2.store.get().elements) &&
        t1.store.get().elements.some((e) => e.x === 500),
    );
    const s = await A.scene(sid);
    expect(s.elements.map((e: { el: SceneElement }) => e.el)).toEqual(t1.store.get().elements);
    // delete in t2 reaches t1
    t2.store.commit(t2.store.get().elements.filter((e) => e.id !== b.id));
    await until(() => t1.store.get().elements.length === 1);
    t1.close();
    t2.close();
  });

  it("edits made while the socket is down arrive after reconnect", async () => {
    const sid = await A.createSession();
    const t1 = await tab(sid);
    const t2 = await tab(sid);
    t1.live.dispose();
    await until(() => !t1.client.connected);
    // t1 is offline; it still saves by REST, and t2 sees it live
    const r = rect();
    t1.store.commit([r]);
    await until(() => t2.store.get().elements.length === 1);
    // t2 edits while t1 is away; t1 catches up through hello+sinceRev
    t2.store.commit([{ ...t2.store.get().elements[0], y: 321 }]);
    await t2.client.settle();
    const live = new LiveChannel(
      t1.client,
      wsUrl(sid),
      null,
      WebSocket as unknown as new (u: string) => globalThis.WebSocket,
    );
    live.start();
    await until(() => t1.store.get().elements[0]?.y === 321);
    live.dispose();
    t2.close();
  });
});
