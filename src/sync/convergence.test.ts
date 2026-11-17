/**
 * Phase 3 unit tests (plan §8): live sync between tabs.
 *
 * The randomised convergence test runs two tabs (Store + SyncClient, exactly
 * as the app wires them) against an in-memory server with the §3.6 rules
 * (per-element versions, last writer wins, puts on a tombstone refused unless
 * based on it, `changes` to every other socket, ordered delivery per socket).
 * A seeded scheduler interleaves local edits (adds, moves, drags, restyles,
 * deletes, layer moves, undo/redo), message delivery and timers. After the
 * edits stop, every replica must hold the same scene and layer keys as the
 * server, the bindings must be consistent, and no tab may push again.
 */
import { describe, expect, it } from "vitest";
import { createLinear, createShape, createText } from "../scene/elements";
import { finalizeScene } from "../scene/scene";
import { moveElements } from "../scene/transform";
import type { LinearElement, SceneElement } from "../scene/types";
import type { Ack, ClientMessage, Op, RemoteOp, SceneSnapshot } from "../shared/protocol";
import type { StorageLike } from "../io/autosave";
import { Store } from "../store/store";
import type { Api } from "./api";
import { SyncClient, type Timers } from "./client";
import { PendingMirror } from "./mirror";

const SID = "AbCdEfGhIjKlMnOpQrStUvWx";

/** mulberry32 */
const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const memory = (): StorageLike => {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

interface Row {
  el: SceneElement | null;
  idx: string;
  version: number;
}

/** The §3.6 server rules, in memory. */
class FakeServer {
  rows = new Map<string, Row>();
  rev = 0;
  settings: Record<string, unknown> = {};
  acks = new Map<string, Ack>();
  pushes = 0;

  apply(push: { pushId: string; ops: Op[] }): { ack: Ack; ops: RemoteOp[] } {
    this.pushes += 1;
    const dup = this.acks.get(push.pushId);
    if (dup) return { ack: { ...dup, duplicate: true }, ops: [] };
    const out: RemoteOp[] = [];
    const ack: Ack = {
      pushId: push.pushId,
      rev: this.rev,
      versions: {},
      rejected: [],
      ignored: [],
    };
    for (const op of push.ops) {
      if (op.t === "put") {
        const row = this.rows.get(op.el.id);
        if (row && row.el === null && op.baseVersion < row.version) {
          ack.rejected.push({ id: op.el.id, reason: "deleted" });
          continue;
        }
        const version = (row?.version ?? 0) + 1;
        this.rows.set(op.el.id, { el: op.el, idx: op.idx, version });
        ack.versions[op.el.id] = version;
        out.push({ t: "put", el: op.el, idx: op.idx, version, needsLayout: false });
      } else if (op.t === "del") {
        const row = this.rows.get(op.id);
        if (!row || row.el === null) {
          ack.ignored.push({ id: op.id, reason: "already_deleted" } as never);
          continue;
        }
        row.el = null;
        row.version += 1;
        ack.versions[op.id] = row.version;
        out.push({ t: "del", id: op.id, version: row.version });
      } else if (op.t === "settings") {
        Object.assign(this.settings, op.settings);
        out.push({ t: "settings", settings: { ...op.settings } });
      }
    }
    if (out.length) this.rev += 1;
    ack.rev = this.rev;
    this.acks.set(push.pushId, ack);
    return { ack, ops: out };
  }

  live() {
    return [...this.rows.entries()]
      .filter(([, r]) => r.el !== null)
      .sort(([ia, a], [ib, b]) => (a.idx < b.idx ? -1 : a.idx > b.idx ? 1 : ia < ib ? -1 : 1));
  }

  snapshot(): SceneSnapshot {
    return {
      rev: this.rev,
      title: "",
      settings: {},
      elements: this.live().map(([, r]) => ({
        el: r.el!,
        idx: r.idx,
        version: r.version,
        needsLayout: false,
      })),
      tombstones: [...this.rows.entries()]
        .filter(([, r]) => r.el === null)
        .map(([id, r]) => ({ id, version: r.version })),
      files: [],
    };
  }
}

/** Virtual time for the clients' throttle and retry timers. */
class Clock implements Timers {
  now = 0;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  private n = 0;
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.n;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(t: unknown) {
    this.tasks.delete(t as number);
  }
  pending() {
    return this.tasks.size;
  }
  /** Runs the next due timer (advancing time); false when there is none. */
  fireNext() {
    let best: [number, { at: number; fn: () => void }] | null = null;
    for (const e of this.tasks) if (!best || e[1].at < best[1].at) best = e;
    if (!best) return false;
    this.tasks.delete(best[0]);
    this.now = Math.max(this.now, best[1].at);
    best[1].fn();
    return true;
  }
}

const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

interface Tab {
  store: Store;
  client: SyncClient;
  toServer: ClientMessage[];
  toClient: unknown[];
  pushes: number;
}

const world = (seedScene: SceneElement[]) => {
  const server = new FakeServer();
  const clock = new Clock();
  // the board starts with the seed scene
  if (seedScene.length) {
    const keys = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"];
    server.apply({
      pushId: "seed-seed-seed-seed",
      ops: seedScene.map((el, i) => ({ t: "put", el, idx: keys[i], baseVersion: 0 })),
    });
  }
  const tabs: Tab[] = [];
  const api = {
    scene: async () => server.snapshot(),
    push: async () => {
      throw new Error("REST push not expected while connected");
    },
  } as unknown as Api;
  const makeTab = () => {
    const snap = server.snapshot();
    const store = new Store();
    store.sessionMode = true;
    store.set({ elements: snap.elements.map((e) => e.el) });
    const tab = {} as Tab;
    const client = new SyncClient(
      SID,
      api,
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
          store.applyRemote(
            elements,
            change,
            settings?.gridEnabled !== undefined ? { gridEnabled: settings.gridEnabled } : {},
          ),
        status: () => {},
        protection: () => {},
        notice: () => {},
        takeLayerMoves: () => {
          const ids = [...store.layerMoves];
          store.layerMoves.clear();
          return ids;
        },
      },
      new PendingMirror(memory(), SID),
      {
        ...snap,
        settings: { viewBackgroundColor: store.get().viewBackgroundColor, gridEnabled: false },
      },
      [],
      { timers: clock },
    );
    store.keyOf = (id) => client.keyOf(id);
    store.onSceneChange = () => client.schedule();
    store.onCommit = () => client.flush();
    Object.assign(tab, { store, client, toServer: [], toClient: [], pushes: 0 });
    tab.toServer.push(client.hello());
    client.attach({ send: (m) => void tab.toServer.push(m) });
    tabs.push(tab);
    return tab;
  };

  /** The server takes the next message from a tab. */
  const serve = (tab: Tab) => {
    const msg = tab.toServer.shift();
    if (!msg) return;
    if (msg.type === "hello") {
      tab.toClient.push({
        type: "changes",
        fromRev: msg.sinceRev ?? 0,
        rev: server.rev,
        ops: [],
        origin: { kind: "browser", name: "A browser" },
      });
      return;
    }
    if (msg.type !== "push") return;
    tab.pushes += 1;
    const { ack, ops } = server.apply(msg as { pushId: string; ops: Op[] });
    if (ops.length)
      for (const other of tabs)
        if (other !== tab)
          other.toClient.push({
            type: "changes",
            fromRev: ack.rev - 1,
            rev: ack.rev,
            ops,
            origin: { kind: "browser", name: "A browser" },
          });
    tab.toClient.push({ type: "ack", ...ack });
  };

  const deliver = (tab: Tab) => {
    const m = tab.toClient.shift();
    if (m) tab.client.receive(m as never);
  };

  /** Delivers everything and runs every timer until nothing is left. */
  const drain = async () => {
    for (let guard = 0; guard < 10000; guard++) {
      await flushMicrotasks();
      const t = tabs.find((x) => x.toServer.length || x.toClient.length);
      if (t) {
        if (t.toServer.length) serve(t);
        else deliver(t);
        continue;
      }
      if (!clock.fireNext()) {
        await flushMicrotasks();
        if (!tabs.some((x) => x.toServer.length || x.toClient.length) && !clock.pending()) return;
      }
    }
    throw new Error("did not settle");
  };

  return { server, clock, tabs, makeTab, serve, deliver, drain };
};

const box = (x: number, y: number) =>
  ({ ...createShape("rectangle", x, y), width: 100, height: 60 }) as SceneElement;

const seedScene = () => {
  const x = box(0, 0);
  const y = box(400, 0);
  const label = {
    ...createText(0, 0, undefined, "label"),
    containerId: x.id,
  } as SceneElement;
  const c: LinearElement = {
    ...createLinear("arrow", 100, 30),
    points: [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
    ],
    width: 300,
    startBinding: { elementId: x.id },
    endBinding: { elementId: y.id },
  };
  return finalizeScene([x, y, label, c as SceneElement]);
};

type Action = (tab: Tab, r: () => number) => Promise<void> | void;

const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
const shapes = (s: Store) => s.get().elements.filter((e) => e.type === "rectangle");

const actions: Action[] = [
  // add a box
  ({ store }, r) => store.commit([...store.get().elements, box(r() * 800, r() * 600)]),
  // move a box (its label and connectors follow)
  ({ store }, r) => {
    const b = shapes(store);
    if (!b.length) return;
    const id = pick(r, b).id;
    store.commit(moveElements(store.get().elements, new Set([id]), r() * 80 - 40, r() * 80 - 40));
  },
  // a drag: several live steps, then one history step
  ({ store }, r) => {
    const b = shapes(store);
    if (!b.length) return;
    const ids = new Set([pick(r, b).id]);
    const before = store.snapshot();
    for (let i = 1; i <= 3; i++)
      store.updateElements(moveElements(store.rebase(before), ids, i * 10, i * 5));
    store.commitFrom(before);
  },
  // restyle
  ({ store }, r) => {
    const els = store.get().elements;
    if (!els.length) return;
    const id = pick(r, els).id;
    const color = pick(r, ["#e03131", "#2f9e44", "#1971c2", "#f08c00"]);
    store.commit(els.map((e) => (e.id === id ? { ...e, strokeColor: color } : e)));
  },
  // delete a box (with its label)
  ({ store }, r) => {
    const b = shapes(store);
    if (b.length < 2 || r() < 0.5) return;
    const id = pick(r, b).id;
    store.commit(
      store
        .get()
        .elements.filter((e) => e.id !== id && !(e.type === "text" && e.containerId === id)),
    );
  },
  // bring to front
  ({ store }, r) => {
    const els = store.get().elements;
    if (els.length < 2) return;
    const el = pick(r, els);
    store.commit([...els.filter((e) => e !== el), el], {}, new Set([el.id]));
  },
  // undo / redo
  ({ store }) => void store.undo(),
  ({ store }) => void store.redo(),
];

const run = async (seed: number, steps = 40) => {
  const r = rng(seed);
  const w = world(seedScene());
  const t1 = w.makeTab();
  const t2 = w.makeTab();
  await w.drain();
  let done = 0;
  while (done < steps) {
    await flushMicrotasks();
    const tab = r() < 0.5 ? t1 : t2;
    const roll = r();
    if (roll < 0.3) {
      await pick(r, actions)(tab, r);
      done += 1;
    } else if (roll < 0.55 && tab.toServer.length) w.serve(tab);
    else if (roll < 0.85 && tab.toClient.length) w.deliver(tab);
    else w.clock.fireNext();
  }
  await w.drain();
  return { w, t1, t2 };
};

const keyed = (tab: Tab) =>
  tab.store
    .get()
    .elements.map((e) => ({ id: e.id, key: tab.client.keyOf(e.id), json: JSON.stringify(e) }));

describe("randomised two-tab convergence (Rule B, C, E, F)", () => {
  it("100 seeded delivery orders converge with equal scenes, keys and sound bindings", async () => {
    for (let seed = 1; seed <= Number(process.env.SEEDS ?? 100); seed++) {
      const { w, t1, t2 } = await run(seed, Number(process.env.STEPS ?? 40));
      const ctx = `seed ${seed}`;
      const a = keyed(t1);
      const b = keyed(t2);
      expect(b, ctx).toEqual(a);
      const server = w.server
        .live()
        .map(([id, row]) => ({ id, key: row.idx, json: JSON.stringify(row.el) }));
      expect(a, ctx).toEqual(server);
      // binding invariants: derived fields are already consistent in every replica
      for (const t of [t1, t2]) {
        const els = t.store.get().elements;
        expect(finalizeScene(els), ctx).toBe(els);
        const ids = new Set(els.map((e) => e.id));
        for (const e of els) {
          if (e.type === "text" && e.containerId) expect(ids.has(e.containerId), ctx).toBe(true);
          if (e.type === "arrow") {
            const l = e as LinearElement;
            if (l.startBinding) expect(ids.has(l.startBinding.elementId), ctx).toBe(true);
            if (l.endBinding) expect(ids.has(l.endBinding.elementId), ctx).toBe(true);
          }
        }
      }
      // quiescence: nobody pushes again
      const before = w.server.pushes;
      for (let i = 0; i < 20; i++) w.clock.fireNext();
      w.clock.now += 10_000;
      await w.drain();
      expect(w.server.pushes, ctx).toBe(before);
    }
  }, 60_000);
});

describe("Rule B: remote changes on the current board", () => {
  it("a remote op arriving between a local edit and its flush keeps both", async () => {
    const w = world([box(0, 0), box(200, 0)]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    const [a, b] = t1.store.get().elements;
    // t1 edits a (not flushed yet: a drag step, no history step)
    t1.store.updateElements(
      t1.store.get().elements.map((e) => (e.id === a.id ? { ...e, x: 50 } : e)),
    );
    // t2's edit to b and to a arrives first
    t2.store.commit(
      t2.store
        .get()
        .elements.map((e) =>
          e.id === b.id ? { ...e, y: 99 } : e.id === a.id ? { ...e, strokeColor: "#e03131" } : e,
        ),
    );
    w.serve(t2);
    w.serve(t2);
    w.deliver(t1);
    w.deliver(t1);
    const now = t1.store.get().elements;
    expect(now.find((e) => e.id === a.id)!.x).toBe(50); // local edit kept
    expect(now.find((e) => e.id === b.id)!.y).toBe(99); // remote edit applied
    await w.drain();
    // last writer wins on a: t1's later put
    expect(keyed(t1)).toEqual(keyed(t2));
    expect(t2.store.get().elements.find((e) => e.id === a.id)!.x).toBe(50);
  });

  it("a remote change is not an undo step and undo keeps others' work", async () => {
    const w = world([box(0, 0)]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    const a = t1.store.get().elements[0];
    t1.store.commit(t1.store.get().elements.map((e) => ({ ...e, x: 300 })));
    await w.drain();
    const c = box(900, 900);
    t2.store.commit([...t2.store.get().elements, c]);
    await w.drain();
    expect(t1.store.get().elements.map((e) => e.id)).toEqual([a.id, c.id]);
    // undo in t1 undoes only t1's move; t2's box stays
    t1.store.undo();
    expect(t1.store.get().elements.map((e) => e.id)).toEqual([a.id, c.id]);
    expect(t1.store.get().elements[0].x).toBe(0);
    await w.drain();
    expect(t2.store.get().elements.map((e) => [e.id, e.x])).toEqual([
      [a.id, 0],
      [c.id, 900],
    ]);
    // t2 cannot undo t1's step
    t2.store.undo();
    expect(t2.store.get().elements.map((e) => e.id)).toEqual([a.id]);
  });

  it("a restore of an older snapshot replays remote changes (removal guard)", async () => {
    const w = world([box(0, 0)]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    const before = t1.store.snapshot();
    t2.store.commit([...t2.store.get().elements, box(500, 500)]);
    await w.drain();
    expect(t1.store.get().elements).toHaveLength(2);
    // a cancelled gesture puts back the scene from its start
    t1.store.set({ elements: before.elements });
    expect(t1.store.get().elements).toHaveLength(2);
    expect(t1.store.staleRestores).toBe(1);
  });

  it("a put to an item removed meanwhile is refused and the item goes away", async () => {
    const w = world([box(0, 0)]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    t2.store.commit([]);
    t1.store.commit(t1.store.get().elements.map((e) => ({ ...e, x: 5 })));
    w.serve(t2); // the delete lands first
    await w.drain();
    expect(t1.store.get().elements).toEqual([]);
    expect(t2.store.get().elements).toEqual([]);
  });
});

describe("Rule E: layer order", () => {
  it("reorders in either tab end with the same order and keys everywhere", async () => {
    const w = world([box(0, 0), box(10, 0), box(20, 0), box(30, 0)]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    const [a, , , d] = t1.store.get().elements;
    t1.store.commit(
      [...t1.store.get().elements.filter((e) => e.id !== a.id), a],
      {},
      new Set([a.id]),
    );
    const els2 = t2.store.get().elements;
    t2.store.commit([d, ...els2.filter((e) => e.id !== d.id)], {}, new Set([d.id]));
    await w.drain();
    expect(keyed(t1)).toEqual(keyed(t2));
    const order = t1.store.get().elements.map((e) => e.id);
    expect(order[0]).toBe(d.id);
    expect(order[3]).toBe(a.id);
  });
});

describe("Rule F: stale bindings are repaired", () => {
  it("X/C/Y: one tab moves X while the other moves Y; the connector ends at both", async () => {
    for (const order of ["t1-first", "t2-first"]) {
      const scene = seedScene();
      const w = world(scene);
      const t1 = w.makeTab();
      const t2 = w.makeTab();
      await w.drain();
      const [x, y, , c] = scene;
      t1.store.commit(moveElements(t1.store.get().elements, new Set([x.id]), 0, 200));
      t2.store.commit(moveElements(t2.store.get().elements, new Set([y.id]), 0, -200));
      // both pushes reach the server before either tab hears of the other
      if (order === "t1-first") {
        w.serve(t1);
        w.serve(t2);
      } else {
        w.serve(t2);
        w.serve(t1);
      }
      await w.drain();
      expect(keyed(t1), order).toEqual(keyed(t2));
      const els = t1.store.get().elements;
      expect(finalizeScene(els), order).toBe(els);
      const conn = els.find((e) => e.id === c.id) as LinearElement;
      const fresh = finalizeScene(
        els.map((e) => (e.id === c.id ? { ...e, x: 0, y: 0 } : e)),
        [x.id, y.id],
      ).find((e) => e.id === c.id) as LinearElement;
      expect(conn.x, order).toBeCloseTo(fresh.x);
      expect(conn.y, order).toBeCloseTo(fresh.y);
    }
  });

  it("a label's container changed remotely while the label is typed in keeps both", async () => {
    const scene = seedScene();
    const w = world(scene);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    const [x, , label] = scene;
    // t1 types into the label (live, not flushed)
    t1.store.updateElements(
      t1.store
        .get()
        .elements.map((e) =>
          e.id === label.id
            ? ({ ...e, text: "a much longer label that wraps" } as SceneElement)
            : e,
        ),
    );
    // t2 moves the box
    t2.store.commit(moveElements(t2.store.get().elements, new Set([x.id]), 300, 300));
    w.serve(t2);
    w.serve(t2);
    w.deliver(t1);
    w.deliver(t1);
    await w.drain();
    expect(keyed(t1)).toEqual(keyed(t2));
    const els = t1.store.get().elements;
    expect(finalizeScene(els)).toBe(els);
    const lab = els.find((e) => e.id === label.id)!;
    expect((lab as { text: string }).text).toBe("a much longer label that wraps");
    expect(els.find((e) => e.id === x.id)!.x).toBe(x.x + 300);
  });
});

describe("1,000-item drag", () => {
  it("a drag of 1,000 items reaches the other tab", async () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      box((i % 40) * 30, Math.floor(i / 40) * 30),
    );
    const w = world([]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    t1.store.commit(many);
    await w.drain();
    expect(t2.store.get().elements).toHaveLength(1000);
    const ids = new Set(many.map((e) => e.id));
    const before = t1.store.snapshot();
    for (let i = 1; i <= 5; i++) {
      t1.store.updateElements(moveElements(t1.store.rebase(before), ids, i * 20, 0));
      w.clock.fireNext();
      await w.drain();
    }
    t1.store.commitFrom(before);
    await w.drain();
    expect(t2.store.get().elements.every((e, i) => e.x === many[i].x + 100)).toBe(true);
    expect(keyed(t1)).toEqual(keyed(t2));
  });
});

describe("a watching tab", () => {
  it("applies a remote change without a save timer or a push of its own", async () => {
    const w = world([box(0, 0)]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    const pushes = t2.pushes;
    t1.store.commit(t1.store.get().elements.map((e) => ({ ...e, x: 300 })));
    w.serve(t1);
    w.deliver(t2);
    expect(t2.store.get().elements[0].x).toBe(300);
    expect(t2.client.isIdle()).toBe(true); // the status stays Saved
    await w.drain();
    expect(t2.pushes).toBe(pushes);
  });
});

describe("own writes coming back", () => {
  it("an echo of this tab's own put or delete is not logged for undo", async () => {
    const w = world([box(0, 0)]);
    const t1 = w.makeTab();
    await w.drain();
    const el = t1.store.get().elements[0];
    const head = t1.store.remoteLog.head;
    // the server echoes what this tab wrote over REST (an import, a keepalive push)
    t1.client.receive({
      type: "changes",
      fromRev: w.server.rev,
      rev: w.server.rev + 1,
      ops: [{ t: "put", el, idx: t1.client.keyOf(el.id)!, version: 2, needsLayout: false }],
      origin: { kind: "browser", name: "A browser" },
    } as never);
    expect(t1.store.remoteLog.head).toBe(head);
    t1.store.commit([]);
    await w.drain();
    t1.client.receive({
      type: "changes",
      fromRev: w.server.rev,
      rev: w.server.rev + 1,
      ops: [{ t: "del", id: el.id, version: 9 }],
      origin: { kind: "browser", name: "A browser" },
    } as never);
    expect(t1.store.remoteLog.head).toBe(head);
    // so undo brings the item back
    t1.store.undo();
    expect(t1.store.get().elements.map((e) => e.id)).toEqual([el.id]);
  });
});
