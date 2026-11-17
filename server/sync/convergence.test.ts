/**
 * Phase 3 convergence tests (plan §8): live sync between tabs.
 *
 * Two tabs (Store + SyncClient + Controller, wired as the app wires them) and
 * a scripted agent talk to a real SessionService (in-memory SQLite) through
 * the real sync core (`createSyncCore`, the protocol behind the WebSocket),
 * over an in-process transport. A seeded scheduler interleaves the actors'
 * steps, message delivery (ordered per socket, as on a WebSocket) and the
 * clients' timers. Each tab has its own text measurer (different font
 * states). After everything is delivered every replica must equal the
 * server, the bindings must be geometrically sound, and nobody may push again.
 */
import fs from "node:fs";
import { generateNKeysBetween } from "fractional-indexing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../config";
import { openDatabase } from "../db/schema";
import { SessionService } from "../sessions/service";
import { tempDir } from "../test/helpers";
import { createSyncCore, type SyncConn, type SyncCore } from "./socket";
import { createLinear, createShape, createText } from "../../src/scene/elements";
import { getAbsolutePoints, getCenter } from "../../src/scene/geometry";
import { polylineMidpoint, routedPoints } from "../../src/scene/route";
import { boundaryPoint, finalizeScene, sidePoint } from "../../src/scene/scene";
import {
  containerTextHeight,
  defaultMeasure,
  setMeasure,
  type MeasureFn,
} from "../../src/scene/text";
import { moveElements } from "../../src/scene/transform";
import type { LinearElement, SceneElement, TextElement } from "../../src/scene/types";
import type { ClientMessage, Op, ServerMessage } from "../../src/shared/protocol";
import { newPushId } from "../../src/shared/ids";
import type { StorageLike } from "../../src/io/autosave";
import { Store } from "../../src/store/store";
import { Controller, type PointerInput } from "../../src/tools/controller";
import type { Api } from "../../src/sync/api";
import { SyncClient, type Timers } from "../../src/sync/client";
import { PendingMirror } from "../../src/sync/mirror";

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

/** Tab 2 renders text 15 % wider than tab 1 (another font state). */
const MEASURES: MeasureFn[] = [defaultMeasure, (t, f) => defaultMeasure(t, f) * 1.15];
const AGENT = { kind: "agent" as const, name: "Test agent" };
const BROWSER = { kind: "browser" as const, name: "A browser" };

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  setMeasure(defaultMeasure);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Virtual time for the clients' throttle and retry timers. */
class Clock {
  now = 0;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  private n = 0;
  /** timers whose callbacks run with `wrap` (the tab's measurer) */
  timers(wrap: (fn: () => void) => void): Timers {
    return {
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++this.n;
        this.tasks.set(id, { at: this.now + ms, fn: () => wrap(fn) });
        return id;
      },
      clearTimeout: (t: unknown) => void this.tasks.delete(t as number),
    };
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
  n: number;
  store: Store;
  controller: Controller;
  client: SyncClient;
  conn: SyncConn;
  toServer: ClientMessage[];
  toClient: ServerMessage[];
  pushes: number;
  notices: string[];
  /** runs `fn` with this tab's text measurer installed */
  as<T>(fn: () => T): T;
}

const world = (seedScene: SceneElement[]) => {
  const service = new SessionService(openDatabase(":memory:"), {
    limits: DEFAULT_LIMITS,
    mediaDir: dir,
  });
  const clock = new Clock();
  // the server's push and hello rate limits run on the same virtual clock
  const core: SyncCore = createSyncCore(service, { limits: DEFAULT_LIMITS, now: () => clock.now });
  const sid = service.create().sessionId;
  if (seedScene.length) {
    const keys = generateNKeysBetween(null, null, seedScene.length);
    service.apply(
      sid,
      {
        pushId: newPushId(),
        baseRev: 0,
        ops: seedScene.map((el, i) => ({ t: "put", el, idx: keys[i], baseVersion: 0 })),
      },
      { origin: BROWSER, atomic: true },
    );
  }
  const tabs: Tab[] = [];
  let pushes = 0;
  const api = {
    scene: async () => service.snapshot(sid),
    push: async () => {
      throw new Error("REST push not expected while connected");
    },
  } as unknown as Api;

  const makeTab = () => {
    const n = tabs.length;
    const as = <T>(fn: () => T): T => {
      setMeasure(MEASURES[n % MEASURES.length]);
      try {
        return fn();
      } finally {
        setMeasure(defaultMeasure);
      }
    };
    const snap = service.snapshot(sid);
    const store = new Store();
    store.sessionMode = true;
    store.set({ elements: snap.elements.map((e) => e.el) });
    const tab = { n, as, toServer: [], toClient: [], pushes: 0, notices: [] } as unknown as Tab;
    const client = new SyncClient(
      sid,
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
        notice: (m) => void tab.notices.push(m),
        takeLayerMoves: () => {
          const ids = [...store.layerMoves];
          store.layerMoves.clear();
          return ids;
        },
      },
      new PendingMirror(memory(), sid),
      {
        ...snap,
        settings: { viewBackgroundColor: store.get().viewBackgroundColor, gridEnabled: false },
      },
      [],
      { timers: clock.timers((fn) => as(fn)) },
    );
    store.keyOf = (id) => client.keyOf(id);
    store.onSceneChange = () => client.schedule();
    store.onCommit = () => client.flush();
    const conn = core.connect(sid, {
      send: (text) => void tab.toClient.push(JSON.parse(text) as ServerMessage),
      close: () => {
        throw new Error("the server closed a test socket");
      },
    });
    if ("refused" in conn) throw new Error("refused");
    Object.assign(tab, { store, client, conn, controller: new Controller(store) });
    tab.toServer.push(client.hello());
    client.attach({ send: (m) => void tab.toServer.push(m) });
    tabs.push(tab);
    return tab;
  };

  /** The server takes the next message from a tab. */
  const serve = (tab: Tab) => {
    const msg = tab.toServer.shift();
    if (!msg) return;
    if (msg.type === "push") {
      tab.pushes += 1;
      pushes += 1;
    }
    tab.conn.receive(JSON.stringify(msg));
  };

  const deliver = (tab: Tab) => {
    const m = tab.toClient.shift();
    if (m) tab.as(() => tab.client.receive(m as never));
  };

  /** Delivers everything and runs every timer until nothing is left. */
  const drain = async () => {
    for (let guard = 0; guard < 20000; guard++) {
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
    throw new Error(
      `did not settle: ${tabs.map((t) => `${t.toServer.length}/${t.toClient.length}`).join(" ")} timers ${clock.pending()} pushes ${pushes}`,
    );
  };

  /** The server's live scene in layer order. */
  const live = () =>
    service
      .snapshot(sid)
      .elements.map((e) => ({ id: e.el.id, key: e.idx, json: JSON.stringify(e.el) }));

  /** An agent write (as the MCP tools will do in phase 4): puts based on the current versions. */
  const agent = (puts: { el: SceneElement; idx?: string }[]) => {
    const snap = service.snapshot(sid);
    const byId = new Map(snap.elements.map((e) => [e.el.id, e]));
    const last = snap.elements.at(-1)?.idx ?? null;
    const fresh = generateNKeysBetween(last, null, puts.filter((p) => !byId.has(p.el.id)).length);
    let f = 0;
    const ops: Op[] = puts.map(({ el, idx }) => {
      const cur = byId.get(el.id);
      return {
        t: "put",
        el,
        idx: idx ?? cur?.idx ?? fresh[f++],
        baseVersion: cur?.version ?? 0,
      };
    });
    const tomb = new Map(snap.tombstones.map((t) => [t.id, t.version]));
    for (const op of ops)
      if (op.t === "put" && tomb.has(op.el.id)) op.baseVersion = tomb.get(op.el.id)!;
    service.apply(
      sid,
      { pushId: newPushId(), baseRev: snap.rev, ops },
      { origin: AGENT, atomic: false },
    );
  };
  const serverEl = (id: string) => service.snapshot(sid).elements.find((e) => e.el.id === id)?.el;

  return {
    service,
    sid,
    clock,
    tabs,
    makeTab,
    serve,
    deliver,
    drain,
    live,
    agent,
    serverEl,
    pushes: () => pushes,
    rev: () => service.snapshot(sid).rev,
  };
};
type World = ReturnType<typeof world>;

const box = (x: number, y: number) =>
  ({
    ...createShape("rectangle", x, y),
    width: 100,
    height: 60,
    backgroundColor: "#ffec99",
    fillStyle: "solid",
  }) as SceneElement;

/** X (labelled) --C (labelled)--> Y, plus Z and W. */
const seedScene = () => {
  const x = box(0, 0);
  const y = box(400, 0);
  const z = box(0, 300);
  const w = box(400, 300);
  const label = { ...createText(0, 0, undefined, "label"), containerId: x.id } as SceneElement;
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
  const cLabel = { ...createText(0, 0, undefined, "uses"), containerId: c.id } as SceneElement;
  const scene = finalizeScene([x, y, z, w, label, c as SceneElement, cLabel]);
  return { scene, x, y, z, w, label, c, cLabel };
};

const input = (x: number, y: number): PointerInput => ({
  x,
  y,
  button: 0,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
});
const find = (s: Store, id: string) => s.get().elements.find((e) => e.id === id)!;

const keyed = (tab: Tab) =>
  tab.store
    .get()
    .elements.map((e) => ({ id: e.id, key: tab.client.keyOf(e.id), json: JSON.stringify(e) }));

const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) <= 1e-6 && Math.abs(a.y - b.y) <= 1e-6;

/**
 * Geometric binding invariants: every bound connector end lies on its
 * target's boundary (side point for elbow routing) facing the other end, and
 * every label is centred on its box (or on the connector path) and fits.
 */
const bindingProblems = (els: readonly SceneElement[]): string[] => {
  const byId = new Map(els.map((e) => [e.id, e]));
  const out: string[] = [];
  for (const e of els) {
    if (e.type === "arrow" || e.type === "line") {
      const l = e as LinearElement;
      const abs = getAbsolutePoints(l);
      const n = abs.length;
      const start = l.startBinding ? byId.get(l.startBinding.elementId) : undefined;
      const end = l.endBinding ? byId.get(l.endBinding.elementId) : undefined;
      if (l.startBinding && !start) out.push(`${e.id}: start bound to a missing item`);
      if (l.endBinding && !end) out.push(`${e.id}: end bound to a missing item`);
      const elbow = l.type === "arrow" && l.routing === "elbow";
      if (start) {
        const toward = elbow
          ? end
            ? getCenter(end)
            : abs[1]
          : n === 2 && end
            ? getCenter(end)
            : abs[1];
        const want = elbow ? sidePoint(start, toward) : boundaryPoint(start, toward);
        if (!near(abs[0], want))
          out.push(
            `${e.id}: start ${JSON.stringify(abs[0])} not on ${start.id} at ${JSON.stringify(want)}`,
          );
      }
      if (end) {
        const toward = elbow
          ? start
            ? getCenter(start)
            : abs[n - 2]
          : n === 2 && start
            ? getCenter(start)
            : abs[n - 2];
        const want = elbow ? sidePoint(end, toward) : boundaryPoint(end, toward);
        if (!near(abs[n - 1], want))
          out.push(
            `${e.id}: end ${JSON.stringify(abs[n - 1])} not on ${end.id} at ${JSON.stringify(want)}`,
          );
      }
    }
    if (e.type === "text" && (e as TextElement).containerId) {
      const t = e as TextElement;
      const host = byId.get(t.containerId!);
      if (!host) {
        out.push(`${e.id}: label of a missing item`);
        continue;
      }
      const centre = getCenter(t);
      if (host.type === "arrow" || host.type === "line") {
        const mid = polylineMidpoint(routedPoints(host as LinearElement));
        if (!near(centre, mid))
          out.push(
            `${e.id}: connector label at ${JSON.stringify(centre)}, path middle ${JSON.stringify(mid)}`,
          );
      } else {
        if (!near(centre, getCenter(host))) out.push(`${e.id}: label not centred on ${host.id}`);
        if (t.height > containerTextHeight(host) + 1e-6)
          out.push(`${e.id}: label does not fit ${host.id}`);
      }
    }
  }
  return out;
};

type Step = (w: World) => void | Promise<void>;

/**
 * The §8 script. Tab 1 drags X (C and X's label follow) with the Controller
 * while the agent moves Y, adds 20 items and edits 5 of them; tab 2 edits the
 * connector label, restyles and sends W to the back; tab 1 cancels a drag of Z
 * with Esc, brings Z forward and undoes twice.
 */
const script = (s: ReturnType<typeof seedScene>, agentItems: SceneElement[]) => {
  const t1 = (w: World) => w.tabs[0];
  const t2 = (w: World) => w.tabs[1];
  const drag = (id: string, dx: number, dy: number, moves: number, end: "up" | "esc"): Step[] => {
    const steps: Step[] = [];
    let from = { x: 0, y: 0 };
    steps.push((w) => {
      const tab = t1(w);
      tab.as(() => {
        tab.store.set({ selectedIds: new Set([id]) });
        const el = find(tab.store, id);
        // a point inside the box, away from its label
        from = { x: el.x + 10, y: el.y + 8 };
        tab.controller.pointerDown(input(from.x, from.y));
      });
    });
    for (let i = 1; i <= moves; i++)
      steps.push((w) =>
        t1(w).as(() =>
          t1(w).controller.pointerMove(input(from.x + (dx * i) / moves, from.y + (dy * i) / moves)),
        ),
      );
    let startAt = { x: 0, y: 0 };
    steps.splice(1, 0, (w) => {
      const el = find(t1(w).store, id);
      startAt = { x: el.x, y: el.y };
    });
    steps.push((w) =>
      t1(w).as(() => {
        const st = t1(w).store;
        // the Controller really moved the item (snapping may shift it a few px)
        expect(Math.abs(find(st, id).x - startAt.x - dx)).toBeLessThan(10);
        expect(Math.abs(find(st, id).y - startAt.y - dy)).toBeLessThan(10);
        if (end === "up") t1(w).controller.pointerUp(input(from.x + dx, from.y + dy));
        else {
          t1(w).controller.cancel();
          expect(find(st, id).x).toBeCloseTo(startAt.x);
        }
      }),
    );
    return steps;
  };
  const tab1: Step[] = [
    ...drag(s.x.id, 120, 90, 5, "up"),
    ...drag(s.z.id, 200, -50, 3, "esc"),
    // bring Z forward
    (w) =>
      t1(w).as(() => {
        const st = t1(w).store;
        const els = st.get().elements;
        const i = els.findIndex((e) => e.id === s.z.id);
        if (i < 0 || i === els.length - 1) return;
        const next = [...els];
        [next[i], next[i + 1]] = [next[i + 1], next[i]];
        st.commit(next, {}, new Set([s.z.id]));
      }),
    (w) => void t1(w).as(() => t1(w).store.undo()),
    (w) => void t1(w).as(() => t1(w).store.undo()),
  ];
  const tab2: Step[] = [
    // edit the connector label (a history step, like finishing a text edit)
    (w) =>
      t2(w).as(() => {
        const st = t2(w).store;
        st.commit(
          finalizeScene(
            st
              .get()
              .elements.map((e) =>
                e.id === s.cLabel.id ? ({ ...e, text: "depends on" } as SceneElement) : e,
              ),
            [s.cLabel.id],
          ),
        );
      }),
    // restyle W and C's label
    (w) =>
      t2(w).as(() => {
        const st = t2(w).store;
        st.commit(
          st
            .get()
            .elements.map((e) =>
              e.id === s.w.id || e.id === s.cLabel.id ? { ...e, strokeColor: "#1971c2" } : e,
            ),
        );
      }),
    // send W to the back
    (w) =>
      t2(w).as(() => {
        const st = t2(w).store;
        const els = st.get().elements;
        const el = els.find((e) => e.id === s.w.id);
        if (!el) return;
        st.commit([el, ...els.filter((e) => e !== el)], {}, new Set([el.id]));
      }),
  ];
  const agent: Step[] = [
    // move Y down (the agent does not lay out C: Rule F repairs it in the tabs)
    (w) => {
      const y = w.serverEl(s.y.id)!;
      w.agent([{ el: { ...y, y: y.y + 150 } }]);
    },
    (w) => w.agent(agentItems.slice(0, 10).map((el) => ({ el }))),
    (w) => w.agent(agentItems.slice(10).map((el) => ({ el }))),
    (w) =>
      w.agent(
        agentItems
          .slice(0, 5)
          .map((el) => ({ el: { ...w.serverEl(el.id)!, strokeColor: "#2f9e44" } })),
      ),
  ];
  return [tab1, tab2, agent];
};

const runScript = async (seed: number) => {
  const r = rng(seed);
  const s = seedScene();
  const w = world(s.scene);
  w.makeTab();
  w.makeTab();
  await w.drain();
  const agentItems = Array.from({ length: 20 }, (_, i) => box(900 + (i % 5) * 120, (i >> 2) * 90));
  const actors = script(s, agentItems);
  const [t1, t2] = w.tabs;
  for (let guard = 0; guard < 5000; guard++) {
    await flushMicrotasks();
    const left = actors.filter((a) => a.length);
    if (!left.length) break;
    const roll = r();
    const tab = r() < 0.5 ? t1 : t2;
    if (roll < 0.35) await left[Math.floor(r() * left.length)].shift()!(w);
    else if (roll < 0.6 && tab.toServer.length) w.serve(tab);
    else if (roll < 0.85 && tab.toClient.length) w.deliver(tab);
    else w.clock.fireNext();
  }
  await w.drain();
  return { w, s, agentItems };
};

const expectConverged = async (w: World, ctx: string) => {
  const [t1, t2] = w.tabs;
  const a = keyed(t1);
  expect(keyed(t2), ctx).toEqual(a);
  expect(a, ctx).toEqual(w.live());
  for (const t of w.tabs) expect(bindingProblems(t.store.get().elements), ctx).toEqual([]);
  // quiescence: nobody pushes again
  const before = w.pushes();
  for (let i = 0; i < 20; i++) w.clock.fireNext();
  w.clock.now += 10_000;
  await w.drain();
  expect(w.pushes(), ctx).toBe(before);
};

const SEEDS = Number(process.env.SEEDS ?? 100);

describe("scripted convergence: two tabs, an agent, a real SessionService (§8)", () => {
  it(`${SEEDS} seeded delivery orders converge with sound bindings and stay quiet`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { w } = await runScript(seed);
      await expectConverged(w, `seed ${seed}`);
    }
  }, 120_000);

  it("the agent's items and its move of Y survive the drag, the Esc cancel and both undos", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const ctx = `seed ${seed}`;
      const { w, s, agentItems } = await runScript(seed);
      for (const t of w.tabs) {
        const els = t.store.get().elements;
        const ids = new Set(els.map((e) => e.id));
        for (const el of agentItems) expect(ids.has(el.id), ctx).toBe(true);
        for (const el of agentItems.slice(0, 5))
          expect(find(t.store, el.id).strokeColor, ctx).toBe("#2f9e44");
        // Y kept the agent's move
        expect(find(t.store, s.y.id).y, ctx).toBe(s.y.y + 150);
        // Esc put Z back; the second undo took X back to where it was
        expect(find(t.store, s.z.id).x, ctx).toBe(s.z.x);
        expect(find(t.store, s.x.id).x, ctx).toBe(s.x.x);
        expect(find(t.store, s.x.id).y, ctx).toBe(s.x.y);
        // W went to the back in both tabs
        expect(els[0].id, ctx).toBe(s.w.id);
      }
      expect(w.tabs[0].store.history.canUndo, ctx).toBe(false);
    }
  }, 120_000);
});

type Action = (tab: Tab, r: () => number) => Promise<void> | void;
const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
const shapes = (s: Store) => s.get().elements.filter((e) => e.type === "rectangle");

const actions: Action[] = [
  ({ store }, r) => store.commit([...store.get().elements, box(r() * 800, r() * 600)]),
  ({ store }, r) => {
    const b = shapes(store);
    if (!b.length) return;
    store.commit(
      moveElements(store.get().elements, new Set([pick(r, b).id]), r() * 80 - 40, r() * 80 - 40),
    );
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
  ({ store }, r) => {
    const els = store.get().elements;
    if (!els.length) return;
    const id = pick(r, els).id;
    const color = pick(r, ["#e03131", "#2f9e44", "#1971c2", "#f08c00"]);
    store.commit(els.map((e) => (e.id === id ? { ...e, strokeColor: color } : e)));
  },
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
  ({ store }, r) => {
    const els = store.get().elements;
    if (els.length < 2) return;
    const el = pick(r, els);
    store.commit([...els.filter((e) => e !== el), el], {}, new Set([el.id]));
  },
  ({ store }) => void store.undo(),
  ({ store }) => void store.redo(),
];

describe("randomised two-tab convergence (Rule B, C, E, F)", () => {
  it(`${SEEDS} seeded random edit mixes converge with equal scenes, keys and sound bindings`, async () => {
    const steps = Number(process.env.STEPS ?? 40);
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed);
      const w = world(seedScene().scene);
      const [t1, t2] = [w.makeTab(), w.makeTab()];
      await w.drain();
      let done = 0;
      while (done < steps) {
        await flushMicrotasks();
        const tab = r() < 0.5 ? t1 : t2;
        const roll = r();
        if (roll < 0.3) {
          const a = pick(r, actions);
          await tab.as(() => a(tab, r));
          done += 1;
        } else if (roll < 0.55 && tab.toServer.length) w.serve(tab);
        else if (roll < 0.85 && tab.toClient.length) w.deliver(tab);
        else w.clock.fireNext();
      }
      await w.drain();
      await expectConverged(w, `seed ${seed}`);
    }
  }, 120_000);
});

describe("Rule B: remote changes on the current board", () => {
  it("a remote op arriving between a local edit and its flush keeps both", async () => {
    const w = world([box(0, 0), box(200, 0)]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    const [a, b] = t1.store.get().elements;
    t1.store.updateElements(
      t1.store.get().elements.map((e) => (e.id === a.id ? { ...e, x: 50 } : e)),
    );
    t2.store.commit(
      t2.store
        .get()
        .elements.map((e) =>
          e.id === b.id ? { ...e, y: 99 } : e.id === a.id ? { ...e, strokeColor: "#e03131" } : e,
        ),
    );
    w.serve(t2);
    w.deliver(t1);
    const now = t1.store.get().elements;
    expect(now.find((e) => e.id === a.id)!.x).toBe(50); // local edit kept
    expect(now.find((e) => e.id === b.id)!.y).toBe(99); // remote edit applied
    await w.drain();
    expect(keyed(t1)).toEqual(keyed(t2));
    expect(t2.store.get().elements.find((e) => e.id === a.id)!.x).toBe(50);
  });

  it("a remote change during an in-flight push keeps the pending edit", async () => {
    const w = world([box(0, 0), box(200, 0)]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    const [a, b] = t1.store.get().elements;
    t1.store.commit(t1.store.get().elements.map((e) => (e.id === a.id ? { ...e, x: 70 } : e)));
    expect(t1.toServer.some((m) => m.type === "push")).toBe(true); // sent, not acked
    t2.store.commit(
      t2.store
        .get()
        .elements.map((e) =>
          e.id === a.id ? { ...e, strokeColor: "#e03131" } : e.id === b.id ? { ...e, x: 333 } : e,
        ),
    );
    w.serve(t2);
    w.deliver(t1); // t2's change reaches t1 while t1's push is still on its way
    expect(find(t1.store, a.id).x).toBe(70);
    expect(find(t1.store, b.id).x).toBe(333);
    await w.drain();
    expect(keyed(t1)).toEqual(keyed(t2));
    expect(keyed(t1)).toEqual(w.live());
    expect(find(t2.store, a.id).x).toBe(70); // t1's put landed after t2's
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
    t1.store.undo();
    expect(t1.store.get().elements.map((e) => e.id)).toEqual([a.id, c.id]);
    expect(t1.store.get().elements[0].x).toBe(0);
    await w.drain();
    expect(t2.store.get().elements.map((e) => [e.id, e.x])).toEqual([
      [a.id, 0],
      [c.id, 900],
    ]);
    t2.store.undo();
    expect(t2.store.get().elements.map((e) => e.id)).toEqual([a.id]);
  });

  it("undo after 2,100 remote changes from another tab still keeps that tab's items", async () => {
    const w = world([box(0, 0)]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    const a = t1.store.get().elements[0];
    t1.store.commit(t1.store.get().elements.map((e) => ({ ...e, x: 300 })));
    await w.drain();
    for (let i = 0; i < 2100; i++) {
      t2.store.updateElements([...t2.store.get().elements, box(1000 + i, 0)]);
      t2.client.flush();
      while (t2.toServer.length) w.serve(t2);
      w.clock.now += 25; // a drag-like 40 pushes per second, under the rate limit
    }
    await w.drain();
    expect(t1.store.get().elements).toHaveLength(2101);
    t1.store.undo();
    expect(t1.store.get().elements).toHaveLength(2101);
    expect(find(t1.store, a.id).x).toBe(0);
    await w.drain();
    expect(keyed(t1)).toEqual(w.live());
  }, 60_000);

  it("a restore of an older snapshot replays remote changes (removal guard)", async () => {
    const w = world([box(0, 0)]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    const before = t1.store.snapshot();
    t2.store.commit([...t2.store.get().elements, box(500, 500)]);
    await w.drain();
    expect(t1.store.get().elements).toHaveLength(2);
    t1.store.set({ elements: before.elements });
    expect(t1.store.get().elements).toHaveLength(2);
    expect(t1.store.staleRestores).toBe(1);
  });

  it("a put to an item removed meanwhile is refused, the item goes away and a notice says so", async () => {
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
    expect(t1.notices).toEqual(["Someone removed that item, so your change was not kept."]);
  });

  it("a remote delete of an item being dragged here removes it and says so", async () => {
    const w = world([box(0, 0)]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    const a = t1.store.get().elements[0];
    t1.store.set({ selectedIds: new Set([a.id]) });
    t1.controller.pointerDown(input(10, 10));
    t1.controller.pointerMove(input(60, 10));
    t2.store.commit([]);
    await w.drain();
    t1.controller.pointerMove(input(90, 10));
    t1.controller.pointerUp(input(90, 10));
    await w.drain();
    expect(t1.store.get().elements).toEqual([]);
    expect(w.live()).toEqual([]);
    expect(t1.notices).toContain("Someone removed that item, so your change was not kept.");
  });

  it("undo of a delete and Restore use the tombstone version from ack and changes", async () => {
    const w = world([box(0, 0)]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    const a = t1.store.get().elements[0];
    // t1 deletes (its ack carries the tombstone version), t2 hears it in `changes`
    t1.store.commit([]);
    await w.drain();
    expect(t2.store.get().elements).toEqual([]);
    // undo of the delete in t1: a put based on the tombstone is accepted
    t1.store.undo();
    await w.drain();
    expect(w.live().map((e) => e.id)).toEqual([a.id]);
    expect(t2.store.get().elements.map((e) => e.id)).toEqual([a.id]);
    // t2 deletes it, then restores an older scene (Restore = replace the board)
    const old = t2.store.get().elements;
    t2.store.commit([]);
    await w.drain();
    t2.store.commit(old);
    await w.drain();
    expect(w.live().map((e) => e.id)).toEqual([a.id]);
    expect(keyed(t1)).toEqual(keyed(t2));
    expect(t1.notices).toEqual([]);
    expect(t2.notices).toEqual([]);
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
      const s = seedScene();
      const w = world(s.scene);
      const t1 = w.makeTab();
      const t2 = w.makeTab();
      await w.drain();
      t1.as(() =>
        t1.store.commit(moveElements(t1.store.get().elements, new Set([s.x.id]), 0, 200)),
      );
      t2.as(() =>
        t2.store.commit(moveElements(t2.store.get().elements, new Set([s.y.id]), 0, -200)),
      );
      if (order === "t1-first") {
        w.serve(t1);
        w.serve(t2);
      } else {
        w.serve(t2);
        w.serve(t1);
      }
      await w.drain();
      expect(keyed(t1), order).toEqual(keyed(t2));
      expect(bindingProblems(t1.store.get().elements), order).toEqual([]);
    }
  });

  it("an agent move of Y while tab 1 drags X: C ends at both (busy connector repaired)", async () => {
    const s = seedScene();
    const w = world(s.scene);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    t1.store.set({ selectedIds: new Set([s.x.id]) });
    t1.controller.pointerDown(input(10, 8));
    t1.controller.pointerMove(input(60, 58));
    const y = w.serverEl(s.y.id)!;
    w.agent([{ el: { ...y, y: y.y + 150 } }]);
    w.deliver(t1);
    w.deliver(t2);
    t1.controller.pointerMove(input(110, 108));
    t1.controller.pointerUp(input(110, 108));
    await w.drain();
    expect(keyed(t1)).toEqual(keyed(t2));
    expect(keyed(t1)).toEqual(w.live());
    for (const t of [t1, t2]) expect(bindingProblems(t.store.get().elements)).toEqual([]);
    expect(find(t2.store, s.y.id).y).toBe(s.y.y + 150);
  });

  it("with different text measurers, repairs of a non-busy label stop and the tabs agree", async () => {
    const s = seedScene();
    const w = world(s.scene);
    const t1 = w.makeTab(); // measure 1.0
    const t2 = w.makeTab(); // measure 1.15
    await w.drain();
    // t2 writes a long connector label with its own metrics, then the agent moves Y
    t2.as(() =>
      t2.store.commit(
        finalizeScene(
          t2.store
            .get()
            .elements.map((e) =>
              e.id === s.cLabel.id
                ? ({ ...e, text: "a fairly long connector label" } as SceneElement)
                : e,
            ),
          [s.cLabel.id],
        ),
      ),
    );
    await w.drain();
    const y = w.serverEl(s.y.id)!;
    w.agent([{ el: { ...y, y: y.y + 150 } }]);
    await w.drain();
    expect(keyed(t1)).toEqual(keyed(t2));
    expect(keyed(t1)).toEqual(w.live());
    for (const t of [t1, t2]) expect(bindingProblems(t.store.get().elements)).toEqual([]);
    const before = w.pushes();
    w.clock.now += 10_000;
    await w.drain();
    expect(w.pushes()).toBe(before);
  });

  it("a label's container changed remotely while the label is typed in keeps both", async () => {
    const s = seedScene();
    const w = world(s.scene);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    t1.store.updateElements(
      t1.store
        .get()
        .elements.map((e) =>
          e.id === s.label.id
            ? ({ ...e, text: "a much longer label that wraps" } as SceneElement)
            : e,
        ),
    );
    t2.as(() =>
      t2.store.commit(moveElements(t2.store.get().elements, new Set([s.x.id]), 300, 300)),
    );
    w.serve(t2);
    w.deliver(t1);
    await w.drain();
    expect(keyed(t1)).toEqual(keyed(t2));
    const els = t1.store.get().elements;
    expect(bindingProblems(els)).toEqual([]);
    expect((find(t1.store, s.label.id) as TextElement).text).toBe("a much longer label that wraps");
    expect(find(t1.store, s.x.id).x).toBe(s.x.x + 300);
  });
});

describe("1,000-item drag", () => {
  it("a Controller drag of 1,000 items reaches the other tab", async () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      box((i % 40) * 130, Math.floor(i / 40) * 80),
    );
    const w = world([]);
    const t1 = w.makeTab();
    const t2 = w.makeTab();
    await w.drain();
    t1.store.commit(many);
    await w.drain();
    expect(t2.store.get().elements).toHaveLength(1000);
    t1.store.set({ selectedIds: new Set(many.map((e) => e.id)) });
    t1.controller.pointerDown(input(10, 10));
    for (let i = 1; i <= 5; i++) {
      t1.controller.pointerMove(input(10 + i * 20, 10));
      w.clock.fireNext();
      await w.drain();
    }
    t1.controller.pointerUp(input(110, 10));
    await w.drain();
    expect(t2.store.get().elements.every((e, i) => e.x === many[i].x + 100)).toBe(true);
    expect(keyed(t1)).toEqual(keyed(t2));
    expect(keyed(t1)).toEqual(w.live());
  }, 60_000);
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
    expect(t2.client.isIdle()).toBe(true);
    await w.drain();
    expect(t2.pushes).toBe(pushes);
  });
});

describe("hostile server data (Rule B validation)", () => {
  it("an invalid element in `changes` is not shown, is counted and warned about once", async () => {
    const w = world([box(0, 0)]);
    const t1 = w.makeTab();
    await w.drain();
    const warn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...a: unknown[]) => void warnings.push(a);
    try {
      const good = box(50, 50);
      const bad = (x: Record<string, unknown>) =>
        ({
          t: "put",
          el: { ...box(0, 0), ...x },
          idx: "b5",
          version: 1,
          needsLayout: false,
        }) as never;
      t1.client.receive({
        type: "changes",
        fromRev: w.rev(),
        rev: w.rev() + 1,
        ops: [
          bad({ type: "script", src: "javascript:alert(1)" }),
          bad({ x: Number.NaN }),
          bad({ strokeColor: "url(javascript:alert(1))" }),
          { t: "put", el: good, idx: "b6", version: 1, needsLayout: false },
        ],
        origin: BROWSER,
      } as never);
    } finally {
      console.warn = warn;
    }
    const ids = t1.store.get().elements.map((e) => e.id);
    expect(ids).toHaveLength(2);
    expect(t1.client.guard.invalid).toBe(3);
    expect(warnings).toHaveLength(1);
  });

  it("invalid elements in a snapshot are skipped", async () => {
    const w = world([box(0, 0)]);
    const t1 = w.makeTab();
    await w.drain();
    const snap = w.service.snapshot(w.sid);
    const warn = console.warn;
    console.warn = () => {};
    try {
      t1.client.receive({
        type: "snapshot",
        ...snap,
        elements: [
          ...snap.elements,
          {
            el: { ...box(0, 0), width: "<img onerror=alert(1)>" },
            idx: "z0",
            version: 1,
            needsLayout: false,
          },
        ],
      } as never);
    } finally {
      console.warn = warn;
    }
    expect(t1.store.get().elements).toHaveLength(1);
    expect(t1.client.guard.invalid).toBe(1);
  });
});
