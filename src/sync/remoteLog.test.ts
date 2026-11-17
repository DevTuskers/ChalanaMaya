/** Rule C remote log (plan §3.7, §8): latest entry per id, never dropped, fast rebase. */
import { describe, expect, it } from "vitest";
import { generateNKeysBetween } from "fractional-indexing";
import { createShape } from "../scene/elements";
import { applyChange, type RemoteChange } from "../scene/rebase";
import type { SceneElement } from "../scene/types";
import { Store } from "../store/store";
import { RemoteLog } from "./remoteLog";

const rect = (x = 0) => createShape("rectangle", x, 0) as SceneElement;

/** mulberry32 */
const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("RemoteLog (latest entry per id)", () => {
  it("keeps one entry per id however many batches arrive", () => {
    const log = new RemoteLog();
    const a = rect();
    for (let i = 0; i < 10_000; i++) log.append({ upserts: [{ ...a, x: i }], deletes: [] });
    expect(log.size).toBe(1);
    expect(log.rowCount).toBeLessThan(2000);
    expect(log.entry(a.id)!.el!.x).toBe(9999);
  });

  it("undo after 2,100 remote batches keeps every remote item (no limit)", () => {
    const store = new Store();
    store.sessionMode = true;
    const mine = rect();
    store.commit([mine]);
    const keys = generateNKeysBetween(null, null, 2101);
    const keyOf = new Map<string, string>([[mine.id, keys[0]]]);
    store.keyOf = (id) => keyOf.get(id);
    for (let i = 0; i < 2100; i++) {
      const el = rect(i * 10);
      keyOf.set(el.id, keys[i + 1]);
      store.applyRemote([...store.get().elements, el], {
        upserts: [el],
        deletes: [],
        keys: new Map([[el.id, keys[i + 1]]]),
      });
    }
    expect(store.get().elements).toHaveLength(2101);
    store.undo();
    const after = store.get().elements;
    expect(after).toHaveLength(2100);
    expect(after.some((e) => e.id === mine.id)).toBe(false);
  });

  it("applying the latest change per id equals replaying every change (property)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const pool = Array.from({ length: 12 }, (_, i) => rect(i));
      const allKeys = generateNKeysBetween(null, null, 400);
      let nextKey = 0;
      const keys = new Map<string, string>();
      const snapshot: SceneElement[] = [];
      for (const el of pool.slice(0, 6)) {
        keys.set(el.id, allKeys[nextKey++ * 10]);
        snapshot.push(el);
      }
      const log = new RemoteLog();
      // a few batches before the snapshot was taken
      for (let i = 0; i < 3; i++) log.append({ upserts: [{ ...pool[0], x: -i }], deletes: [] });
      const at = log.head;
      const changes: RemoteChange[] = [];
      for (let b = 0; b < 1 + Math.floor(r() * 30); b++) {
        const upserts: SceneElement[] = [];
        const deletes: string[] = [];
        const bk = new Map<string, string>();
        for (let k = 0; k < 1 + Math.floor(r() * 4); k++) {
          const el = pool[Math.floor(r() * pool.length)];
          if (upserts.some((u) => u.id === el.id) || deletes.includes(el.id)) continue;
          if (r() < 0.3) deletes.push(el.id);
          else {
            const key = allKeys[Math.floor(r() * allKeys.length)];
            upserts.push({ ...el, x: Math.floor(r() * 1000) });
            bk.set(el.id, key);
            keys.set(el.id, key);
          }
        }
        const c = { upserts, deletes, keys: bk };
        changes.push(c);
        log.append(c);
      }
      // full replay, each change seeing the keys as they were when it arrived
      const keysThen = new Map(snapshot.map((e, i) => [e.id, allKeys[i * 10]]));
      let full: SceneElement[] = snapshot;
      for (const c of changes) {
        for (const [id, k] of c.keys!) keysThen.set(id, k);
        full = applyChange(full, c, (id) => keysThen.get(id));
      }
      const lazy = log.rebase(snapshot, at, (id) => keys.get(id));
      expect(
        lazy.map((e) => e.id),
        `seed ${seed}`,
      ).toEqual(full.map((e) => e.id));
      lazy.forEach((e, i) => expect(e, `seed ${seed}`).toBe(full[i]));
    }
  });

  it("rebases a 5,000-element snapshot over 2,000 entries in under 10 ms", () => {
    const keys = generateNKeysBetween(null, null, 7000);
    const keyMap = new Map<string, string>();
    const elements = Array.from({ length: 5000 }, (_, i) => {
      const el = rect(i);
      keyMap.set(el.id, keys[i]);
      return el;
    });
    const log = new RemoteLog();
    const at = log.head;
    for (let i = 0; i < 2000; i++) {
      // half edit existing items, half add new ones
      const el = i % 2 ? { ...elements[i * 2], x: -i } : rect(-i);
      const k = i % 2 ? keyMap.get(el.id)! : keys[5000 + i];
      keyMap.set(el.id, k);
      log.append({ upserts: [el], deletes: [], keys: new Map([[el.id, k]]) });
    }
    const keyOf = (id: string) => keyMap.get(id);
    log.rebase(elements, at, keyOf); // warm up
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const out = log.rebase(elements, at, keyOf);
      runs.push(performance.now() - t0);
      expect(out).toHaveLength(6000);
    }
    runs.sort((a, b) => a - b);
    expect(runs[2]).toBeLessThan(10);
  });

  it("applies a 200-op remote batch to a 5,000-element board in under 20 ms", () => {
    const keys = generateNKeysBetween(null, null, 5100);
    const keyMap = new Map<string, string>();
    const elements = Array.from({ length: 5000 }, (_, i) => {
      const el = rect(i);
      keyMap.set(el.id, keys[i]);
      return el;
    });
    const store = new Store();
    store.set({ elements });
    store.keyOf = (id) => keyMap.get(id);
    const batch = (round: number): RemoteChange => {
      const upserts: SceneElement[] = [];
      const ks = new Map<string, string>();
      for (let i = 0; i < 150; i++)
        upserts.push({ ...elements[(round * 150 + i * 31) % 5000], x: round });
      for (let i = 0; i < 40; i++) {
        const el = rect(10_000 + round * 40 + i);
        const k = keys[5000 + ((round * 40 + i) % 100)];
        ks.set(el.id, k);
        upserts.push(el);
      }
      const deletes = Array.from(
        { length: 10 },
        (_, i) => elements[(round * 10 + i * 97 + 7) % 5000].id,
      );
      return { upserts, deletes, keys: ks };
    };
    const runs: number[] = [];
    for (let round = 0; round < 6; round++) {
      const change = batch(round);
      const t0 = performance.now();
      const next = applyChange(
        store.get().elements,
        change,
        (id) => change.keys?.get(id) ?? keyMap.get(id),
      );
      store.applyRemote(next, change);
      runs.push(performance.now() - t0);
    }
    runs.shift(); // warm-up
    runs.sort((a, b) => a - b);
    expect(runs[2]).toBeLessThan(20);
    expect(store.remoteLog.head).toBe(6);
  });
});
