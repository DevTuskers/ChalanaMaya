/**
 * Phase 2 integration tests: the browser's SyncClient against a real server
 * (plan §4.1, §8): chunked saves, atomic imports and safe mirror replays.
 * Type-checked with the app (tsconfig.json), as it uses the browser code.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFreedraw } from "../src/scene/elements";
import type { SceneElement } from "../src/scene/types";
import { createHttpApi, type Api, type PushBody } from "../src/sync/api";
import { SyncClient, replayMirror, type SaveStatus } from "../src/sync/client";
import { PendingMirror } from "../src/sync/mirror";
import type { StorageLike } from "../src/io/autosave";
import { importIntoSession } from "../src/sync/importBoard";
import { Store } from "../src/store/store";
import { api, rect, startServer, type TestServer } from "./test/helpers";
import { call, httpClient } from "./mcp/testClient";
import { defaultMeasure, setMeasure } from "../src/scene/text";

let srv: TestServer;
let A: ReturnType<typeof api>;
beforeAll(async () => {
  srv = await startServer();
  A = api(srv);
});
afterAll(() => srv.close());

const memoryStorage = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

/** Records every push the client sends. */
const spyApi = (inner: Api) => {
  const pushes: PushBody[] = [];
  const spy: Api = {
    ...inner,
    push: (id, body, opts) => {
      pushes.push(body);
      return inner.push(id, body, opts);
    },
  };
  return { spy, pushes };
};

const newSession = async () =>
  (await A.call("POST", "/api/sessions", {})).json().session_id as string;

const startClient = async (sid: string, apiImpl: Api, storage = memoryStorage()) => {
  let elements: SceneElement[] = [];
  const statuses: SaveStatus[] = [];
  const notices: string[] = [];
  const snap = await apiImpl.scene(sid);
  elements = snap.elements.map((e) => e.el);
  const host = {
    scene: () => ({
      elements,
      settings: { viewBackgroundColor: "#fff9ed", gridEnabled: false, title: snap.title },
    }),
    replaceElements: (els: SceneElement[]) => void (elements = els),
    status: (s: SaveStatus) => void statuses.push(s),
    protection: () => {},
    notice: (m: string) => void notices.push(m),
    takeLayerMoves: () => [],
  };
  const client = new SyncClient(sid, apiImpl, host, new PendingMirror(storage, sid), {
    ...snap,
    settings: { viewBackgroundColor: "#fff9ed", gridEnabled: false },
  });
  return {
    client,
    storage,
    notices,
    statuses,
    get: () => elements,
    set: (els: SceneElement[]) => {
      elements = els;
      client.schedule();
    },
  };
};

describe("SyncClient against the server", () => {
  it("saves a 1,000-item move in chunks of at most 500 ops", async () => {
    const sid = await newSession();
    const { spy, pushes } = spyApi(createHttpApi(srv.base));
    const c = await startClient(sid, spy);
    c.set(Array.from({ length: 1000 }, () => rect()));
    await c.client.settle();
    expect(pushes.length).toBe(2);
    pushes.length = 0;
    c.set(c.get().map((e) => ({ ...e, x: e.x + 50 })));
    await c.client.settle();
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    for (const p of pushes) {
      expect(p.ops.length).toBeLessThanOrEqual(500);
      expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(1.5 * 1024 * 1024 + 1024);
    }
    const scene = await A.scene(sid);
    expect(scene.elements).toHaveLength(1000);
    const byId = new Map(c.get().map((e) => [e.id, e]));
    for (const e of scene.elements) {
      expect(e.el.x).toBe(byId.get(e.el.id)!.x);
      expect(e.version).toBe(2);
    }
    expect(c.statuses.at(-1)).toBe("saved");
    // the mirror is empty once everything is acknowledged
    expect([...c.storage.data.keys()].filter((k) => k.startsWith("chalanamaya.pending."))).toEqual(
      [],
    );
  });

  it("imports a 5 MB board as one atomic revision", async () => {
    const sid = await newSession();
    const before = (await A.scene(sid)).rev;
    const strokes = Array.from({ length: 40 }, (_, i) => ({
      ...createFreedraw(i * 20, i * 5),
      points: Array.from({ length: 3800 }, (_, j) => ({
        x: j * 0.3711 + i / 3,
        y: Math.sin(j / 7) * 40 + i / 7,
      })),
    }));
    const file = {
      type: "chalanamaya" as const,
      version: 1,
      source: "test",
      elements: strokes,
      files: {},
      settings: { viewBackgroundColor: "#fff9ed", theme: "light" as const, gridEnabled: false },
    };
    expect(JSON.stringify(file).length).toBeGreaterThan(5 * 1024 * 1024);
    const store = new Store();
    store.sessionMode = true;
    const apiImpl = createHttpApi(srv.base);
    const snap = await apiImpl.scene(sid);
    const client = new SyncClient(
      sid,
      apiImpl,
      {
        scene: () => ({
          elements: store.get().elements,
          settings: {
            viewBackgroundColor: store.get().viewBackgroundColor,
            gridEnabled: store.get().gridEnabled,
            title: "",
          },
        }),
        replaceElements: (els) => store.set({ elements: els }),
        status: () => {},
        protection: () => {},
        notice: () => {},
        takeLayerMoves: () => [],
      },
      new PendingMirror(memoryStorage(), sid),
      { ...snap, settings: { viewBackgroundColor: "#fff9ed", gridEnabled: false } },
    );
    store.onSceneChange = () => client.schedule();
    const r = await importIntoSession(store, client, file as never, "add");
    expect(r.ok).toBe(true);
    await client.settle();
    const after = await A.scene(sid);
    expect(after.elements).toHaveLength(40);
    expect(after.rev).toBe(before + 1);
    // one local undo step removes the whole import
    expect(store.undo()).toBe(true);
    expect(store.get().elements).toHaveLength(0);
    await client.settle();
    expect((await A.scene(sid)).elements).toHaveLength(0);
  }, 60000);

  it("a replayed batch never overwrites newer edits", async () => {
    const sid = await newSession();
    const apiImpl = createHttpApi(srv.base);
    const storage = memoryStorage();
    const el = rect();
    const first = {
      pushId: "replay-test-push-0001",
      baseRev: 0,
      ops: [{ t: "put" as const, el, idx: "a0", baseVersion: 0 }],
    };
    // the batch was sent and mirrored, then the tab died before the ack
    await apiImpl.push(sid, first);
    storage.setItem(
      `chalanamaya.pending.${sid}`,
      JSON.stringify({ v: 1, batches: [first], unsent: [] }),
    );
    // a newer edit lands (another tab or an agent)
    const newer = { ...el, x: 999 };
    await apiImpl.push(sid, {
      pushId: "replay-test-push-0002",
      baseRev: 1,
      ops: [{ t: "put", el: newer, idx: "a0", baseVersion: 1 }],
    });
    const r = await replayMirror(apiImpl, new PendingMirror(storage, sid));
    expect(r).toEqual({ unsent: [], pending: [], lost: 0 });
    expect(storage.data.size).toBe(0);
    const scene = await A.scene(sid);
    expect(scene.elements[0].el.x).toBe(999);
    expect(scene.elements[0].version).toBe(2);
  });

  it("a mirrored replay older than the push log is checked against versions", async () => {
    const sid = await newSession();
    const apiImpl = createHttpApi(srv.base);
    const el = rect();
    await apiImpl.push(sid, {
      pushId: "floor-test-push-00001",
      baseRev: 0,
      ops: [{ t: "put", el: { ...el, x: 5 }, idx: "a0", baseVersion: 0 }],
    });
    // trim the push log so the server no longer remembers the old pushId
    srv.handle.db.prepare("DELETE FROM push_log WHERE session_id = ?").run(sid);
    srv.handle.db.prepare("UPDATE sessions SET push_log_floor_rev = rev + 1 WHERE id = ?").run(sid);
    const ack = await apiImpl.push(sid, {
      pushId: "floor-test-push-00009",
      baseRev: 0,
      mirrored: true,
      ops: [{ t: "put", el: { ...el, x: 1 }, idx: "a0", baseVersion: 0 }],
    });
    expect(ack.ignored).toEqual([{ id: el.id, reason: "stale_replay" }]);
    expect((await A.scene(sid)).elements[0].el.x).toBe(5);
  });

  it("filling push_log past its 2,000-row cap advances push_log_floor_rev", async () => {
    const sid = await newSession();
    const apiImpl = createHttpApi(srv.base);
    const el = rect();
    const firstId = "evict-test-push-000000";
    await apiImpl.push(sid, {
      pushId: firstId,
      baseRev: 0,
      ops: [{ t: "put", el: { ...el, x: 1 }, idx: "a0", baseVersion: 0 }],
    });
    // 2,000 more pushes: the first one falls out of the per-board cap
    for (let i = 1; i <= 2000; i += 1)
      await apiImpl.push(sid, {
        pushId: `evict-test-push-${String(i).padStart(6, "0")}`,
        baseRev: i,
        ops: [{ t: "put", el: { ...el, x: 1 + i }, idx: "a0", baseVersion: i }],
      });
    const rows = srv.handle.db
      .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM push_log WHERE session_id = ?")
      .get(sid)!.n;
    expect(rows).toBe(2000);
    const floor = srv.handle.db
      .prepare<[string], { f: number }>("SELECT push_log_floor_rev AS f FROM sessions WHERE id = ?")
      .get(sid)!.f;
    expect(floor).toBeGreaterThanOrEqual(1);
    // the evicted push replayed from a mirror is no longer known by its id, so
    // it is checked against versions and does not overwrite the newer edits
    const ack = await apiImpl.push(sid, {
      pushId: firstId,
      baseRev: 0,
      mirrored: true,
      ops: [{ t: "put", el: { ...el, x: 1 }, idx: "a0", baseVersion: 0 }],
    });
    expect(ack.duplicate).toBeUndefined();
    expect(ack.ignored).toEqual([{ id: el.id, reason: "stale_replay" }]);
    expect((await A.scene(sid)).elements[0].el.x).toBe(2001);
  }, 120000);

  it("an import is applied once even when it is sent twice", async () => {
    const sid = await newSession();
    const apiImpl = createHttpApi(srv.base);
    const body = {
      importId: "import-dedupe-test-01",
      mode: "add" as const,
      elements: [{ el: rect(), idx: "a0" }],
    };
    const a = await apiImpl.importScene(sid, body);
    const b = await apiImpl.importScene(sid, body);
    expect(b.duplicate).toBe(true);
    expect(b.rev).toBe(a.rev);
    expect((await A.scene(sid)).elements).toHaveLength(1);
  });

  it("refuses an oversized element locally and keeps the server copy", async () => {
    const sid = await newSession();
    const { spy, pushes } = spyApi(createHttpApi(srv.base));
    const c = await startClient(sid, spy);
    const el = rect();
    c.set([el]);
    await c.client.settle();
    pushes.length = 0;
    // a stroke over 256 KB of JSON, under the same id
    const tooBig = {
      ...createFreedraw(0, 0),
      points: Array.from({ length: 3000 }, (_, i) => ({ x: i / 3, y: i / 7 })),
      link: "https://example.com/" + "a".repeat(200000),
      id: el.id,
    } as SceneElement;
    c.set([tooBig]);
    await c.client.settle();
    const scene = await A.scene(sid);
    expect(scene.elements[0].el.type).toBe("rectangle");
    expect(c.get()[0].type).toBe("rectangle");
    expect(c.notices.length).toBeGreaterThan(0);
  });

  it("lays out agent text once when the board is opened after the agent wrote it", async () => {
    const mcp = await httpClient(srv.base, "Claude");
    const typed = createHttpApi(srv.base);
    try {
      const sid = (await call(mcp, "create_session", {})).session_id as string;
      const added = await call(mcp, "add_elements", {
        session_id: sid,
        elements: [
          {
            type: "diamond",
            x: 0,
            y: 0,
            width: 160,
            height: 100,
            label: "A long decision label here",
          },
        ],
      });
      const id = added.created[0].id as string;
      const before = await typed.scene(sid);
      expect(before.elements.some((e) => e.needsLayout)).toBe(true);
      const shapeBefore = before.elements.find((e) => e.el.id === id)!;
      // this "browser" measures text 60 % wider than the server did (containers only grow)
      setMeasure((t, f) => defaultMeasure(t, f) * 1.6);
      try {
        const c = await startClient(sid, createHttpApi(srv.base));
        c.client.correctLoadedLayout();
        await c.client.settle();
        const after = await typed.scene(sid);
        expect(after.elements.every((e) => !e.needsLayout)).toBe(true);
        const shape = after.elements.find((e) => e.el.id === id)!;
        expect(shape.el.height).toBeGreaterThan(shapeBefore.el.height);
        expect(c.get().find((e) => e.id === id)!.height).toBe(shape.el.height);
        // a second open has nothing to correct
        const c2 = await startClient(sid, createHttpApi(srv.base));
        const rev = after.rev;
        c2.client.correctLoadedLayout();
        await c2.client.settle();
        expect((await typed.scene(sid)).rev).toBe(rev);
      } finally {
        setMeasure(defaultMeasure);
      }
    } finally {
      await mcp.close();
    }
  });
});
