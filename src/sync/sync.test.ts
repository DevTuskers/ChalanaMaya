/** Phase 2 unit tests: chunking, the pending mirror, the sync client and Rule D. */
import { describe, expect, it } from "vitest";
import { DEFAULT_STYLE } from "../scene/constants";
import { createShape, createText } from "../scene/elements";
import type { SceneElement } from "../scene/types";
import type { Ack, Op, SceneSnapshot } from "../shared/protocol";
import type { StorageLike } from "../io/autosave";
import { Store } from "../store/store";
import { ApiError, type Api, type PushBody } from "./api";
import {
  ENVELOPE_BYTES,
  KEEPALIVE_BYTES,
  MAX_CHUNK_BYTES,
  chunkOps,
  jsonBytes,
  refuseReason,
} from "./chunk";
import { SyncClient, applyOpsToScene, replayMirror, type SaveStatus } from "./client";
import {
  MIRROR_CAP,
  PendingMirror,
  compactMirror,
  fitMirror,
  mirrorSize,
  mirrorKey,
  type MirrorBatch,
  type MirrorData,
} from "./mirror";
import { RECENT_MAX, boardLabel, forgetBoard, readRecent, rememberBoard, shortId } from "./recent";
import { sessionIdFromPath } from "./session";

const SID = "AbCdEfGhIjKlMnOpQrStUvWx";
const ID2 = "ZyXwVuTsRqPoNmLkJiHgFeDc";

const memory = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};
const fullStorage = (): StorageLike => ({
  getItem: () => null,
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
  removeItem: () => {},
});

const rect = (x = 0) => createShape("rectangle", x, 0) as SceneElement;
const put = (el: SceneElement, idx = "a0", baseVersion = 0): Op => ({
  t: "put",
  el,
  idx,
  baseVersion,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/** An in-memory server that acknowledges pushes like the real one (by pushId). */
const fakeApi = () => {
  const pushes: (PushBody & { keepalive?: boolean })[] = [];
  const seen = new Map<string, Ack>();
  const versions = new Map<string, number>();
  let rev = 0;
  let fail: ApiError | null = null;
  let hold: (() => void) | null = null;
  let held = false;
  const api: Api = {
    createSession: async () => ({ session_id: SID, url: `/s/${SID}` }),
    scene: async () => ({}) as SceneSnapshot,
    push: async (_id, body, opts) => {
      pushes.push({ ...body, keepalive: opts?.keepalive });
      if (held) await new Promise<void>((r) => (hold = r));
      if (fail) throw fail;
      const dup = seen.get(body.pushId);
      if (dup) return { ...dup, duplicate: true };
      rev += 1;
      const v: Record<string, number> = {};
      for (const o of body.ops)
        if (o.t === "put") {
          const n = (versions.get(o.el.id) ?? 0) + 1;
          versions.set(o.el.id, n);
          v[o.el.id] = n;
        }
      const ack = { rev, versions: v, rejected: [], ignored: [] } as unknown as Ack;
      seen.set(body.pushId, ack);
      return ack;
    },
    importScene: async () => {
      rev += 1;
      return { rev, versions: {}, rejected: [], ignored: [] } as unknown as Ack;
    },
    upload: async () => ({ file_id: "f", url: "/u", mime: "image/png" }) as never,
  };
  return {
    api,
    pushes,
    setFail: (e: ApiError | null) => (fail = e),
    hold: () => (held = true),
    release: () => {
      held = false;
      const h = hold;
      hold = null;
      h?.();
    },
  };
};

const emptySnap = {
  rev: 0,
  elements: [],
  tombstones: [],
  files: [],
  settings: { viewBackgroundColor: "#fff9ed", gridEnabled: false },
  title: "",
} as unknown as SceneSnapshot;

const harness = (
  api: Api,
  storage: StorageLike = memory(),
  opts: { pending?: MirrorBatch[]; elements?: SceneElement[]; snap?: SceneSnapshot } = {},
) => {
  let elements: SceneElement[] = opts.elements ?? [];
  const statuses: SaveStatus[] = [];
  const notices: string[] = [];
  const warnings: (string | null)[] = [];
  const mirror = new PendingMirror(storage, SID);
  const client = new SyncClient(
    SID,
    api,
    {
      scene: () => ({
        elements,
        settings: { viewBackgroundColor: "#fff9ed", gridEnabled: false, title: "" },
      }),
      replaceElements: (els) => void (elements = els),
      status: (s) => void statuses.push(s),
      protection: (w) => void warnings.push(w),
      notice: (m) => void notices.push(m),
      takeLayerMoves: () => [],
    },
    mirror,
    (opts.snap ?? emptySnap) as never,
    opts.pending,
  );
  return {
    client,
    mirror,
    statuses,
    notices,
    warnings,
    get: () => elements,
    set: (els: SceneElement[]) => void (elements = els),
  };
};

describe("chunkOps", () => {
  it("splits by count and keeps every op once, in order", () => {
    const ops = Array.from({ length: 1234 }, (_, i) => put(rect(i)));
    const chunks = chunkOps(ops);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 234]);
    expect(chunks.flat()).toEqual(ops);
  });

  it("keeps each push body under 1.5 MB", () => {
    const big = Array.from({ length: 40 }, (_, i) => {
      const t = { ...createText(i, 0), text: "x".repeat(100_000) } as SceneElement;
      return put(t);
    });
    const chunks = chunkOps(big);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks)
      expect(jsonBytes({ pushId: "p".repeat(24), baseRev: 1e9, ops: c })).toBeLessThanOrEqual(
        MAX_CHUNK_BYTES,
      );
    expect(ENVELOPE_BYTES).toBeGreaterThan(100);
  });

  it("keeps a bound label in the same push as its container when it fits", () => {
    const box = rect();
    const label = {
      ...(createText(0, 0, DEFAULT_STYLE, "hi") as SceneElement),
      containerId: box.id,
    };
    const filler = Array.from({ length: 499 }, (_, i) => put(rect(i)));
    const chunks = chunkOps([...filler, put(box), put(label as SceneElement)]);
    const where = (id: string) =>
      chunks.findIndex((c) => c.some((o) => o.t === "put" && o.el.id === id));
    expect(where(box.id)).toBe(where(label.id));
  });

  it("a keepalive chunk stays small", () => {
    const ops = Array.from({ length: 300 }, (_, i) => put(rect(i)));
    const [first] = chunkOps(ops, 500, KEEPALIVE_BYTES - ENVELOPE_BYTES);
    expect(jsonBytes(first)).toBeLessThanOrEqual(KEEPALIVE_BYTES);
    expect(first.length).toBeLessThan(300);
  });

  it("refuses oversized and invalid elements locally", () => {
    expect(refuseReason(rect())).toBeNull();
    const huge = { ...createText(0, 0), text: "y".repeat(300 * 1024) } as SceneElement;
    expect(refuseReason(huge)).not.toBeNull();
    expect(refuseReason({ ...rect(), x: Number.NaN } as SceneElement)).not.toBeNull();
  });
});

describe("pending mirror", () => {
  it("compacts to the newest op per id, keeping each batch's pushId and baseRev", () => {
    const a = rect();
    const b = rect(10);
    const d = compactMirror({
      v: 1,
      batches: [
        { pushId: "p1", baseRev: 3, ops: [put(a), put(b)] },
        { pushId: "p2", baseRev: 4, ops: [put({ ...a, x: 5 } as SceneElement)] },
      ],
      unsent: [{ t: "del", id: b.id, baseVersion: 1 }],
    });
    expect(d.batches).toEqual([{ pushId: "p2", baseRev: 4, ops: [put({ ...a, x: 5 } as never)] }]);
    expect(d.unsent).toHaveLength(1);
  });

  it("fits under the cap by dropping the oldest ops", () => {
    const ops = Array.from({ length: 200 }, (_, i) => put(rect(i)));
    const r = fitMirror({ v: 1, batches: [{ pushId: "p", baseRev: 0, ops }], unsent: [] }, 20_000);
    expect(r.text.length).toBeLessThanOrEqual(20_000);
    expect(r.dropped).toBeGreaterThan(0);
    expect(MIRROR_CAP).toBe(2 * 1024 * 1024);
  });

  it("sizes the mirror exactly without re-serialising, and keeps the newest ops", () => {
    const cases: MirrorData[] = [
      { v: 1, batches: [], unsent: [] },
      { v: 1, batches: [], unsent: [put(rect(1))] },
      {
        v: 1,
        batches: [
          { pushId: "p1", baseRev: 3, ops: [put(rect(1)), put(rect(2))] },
          { pushId: "p2", baseRev: 12, ops: [] },
          { pushId: "p3", baseRev: 120, ops: [{ t: "del", id: "x", baseVersion: 2 }] },
        ],
        unsent: [put(rect(3)), { t: "settings", settings: { gridEnabled: true } }],
      },
    ];
    for (const c of cases) expect(mirrorSize(c)).toBe(JSON.stringify(c).length);
    const ops = Array.from({ length: 300 }, (_, i) => put(rect(i)));
    const data: MirrorData = {
      v: 1,
      batches: [
        { pushId: "a", baseRev: 0, ops: ops.slice(0, 150) },
        { pushId: "b", baseRev: 1, ops: ops.slice(150) },
      ],
      unsent: [],
    };
    const r = fitMirror(data, 30_000);
    expect(r.text.length).toBeLessThanOrEqual(30_000);
    expect(r.text).toBe(JSON.stringify(r.data));
    expect(r.dropped + r.data.batches.reduce((a, b) => a + b.ops.length, 0)).toBe(300);
    // the newest op survives, with its batch's pushId
    expect(r.data.batches.at(-1)).toMatchObject({ pushId: "b" });
    expect(r.data.batches.at(-1)!.ops.at(-1)).toBe(ops[299]);
  });

  it("reports a full storage instead of throwing", () => {
    const m = new PendingMirror(fullStorage(), SID);
    expect(m.write([], [put(rect())])).toEqual({ ok: false, reason: expect.any(String) });
    expect(new PendingMirror(null, SID).write([], [put(rect())]).ok).toBe(false);
  });

  it("removes itself when nothing is pending and ignores junk", () => {
    const s = memory();
    const m = new PendingMirror(s, SID);
    m.write([{ pushId: "p", baseRev: 0, ops: [put(rect())] }], []);
    expect(s.data.has(mirrorKey(SID))).toBe(true);
    m.write([], []);
    expect(s.data.has(mirrorKey(SID))).toBe(false);
    s.setItem(mirrorKey(SID), "{not json");
    expect(m.read()).toBeNull();
  });
});

describe("replayMirror", () => {
  it("replays batches in order with their pushIds and mirrored: true, returning unsent ops", async () => {
    const f = fakeApi();
    const s = memory();
    const m = new PendingMirror(s, SID);
    const extra = put(rect(9));
    m.write(
      [
        { pushId: "push-one", baseRev: 2, ops: [put(rect())] },
        { pushId: "push-two", baseRev: 3, ops: [put(rect(1))] },
      ],
      [extra],
    );
    const r = await replayMirror(f.api, m);
    expect(f.pushes.map((p) => [p.pushId, p.baseRev, p.mirrored])).toEqual([
      ["push-one", 2, true],
      ["push-two", 3, true],
    ]);
    expect(r).toEqual({ unsent: [extra], pending: [], lost: 0 });
    // the delivered batches are not replayed again on the next load
    expect(m.read()).toEqual({ v: 1, batches: [], unsent: [extra] });
  });

  it("clears the mirror after a full replay with nothing unsent", async () => {
    const f = fakeApi();
    const s = memory();
    const m = new PendingMirror(s, SID);
    m.write([{ pushId: "push-only", baseRev: 0, ops: [put(rect())] }], []);
    await replayMirror(f.api, m);
    expect(s.getItem(mirrorKey(SID))).toBeNull();
    await replayMirror(f.api, m);
    expect(f.pushes).toHaveLength(1);
  });

  it("does not throw when the server refuses replays for now (network, 429, 5xx)", async () => {
    for (const err of [
      new ApiError(0, "network", "offline"),
      new ApiError(429, "rate_limited", "slow down"),
      new ApiError(503, "unavailable", "busy"),
    ]) {
      const f = fakeApi();
      f.setFail(err);
      const m = new PendingMirror(memory(), SID);
      const batches = [
        { pushId: "push-aaaaaaaaaaaa", baseRev: 0, ops: [put(rect())] },
        { pushId: "push-bbbbbbbbbbbb", baseRev: 1, ops: [put(rect(1))] },
      ];
      const extra = put(rect(2));
      m.write(batches, [extra]);
      const r = await replayMirror(f.api, m);
      // the first failure stops the replay; that batch and the rest stay pending, in order
      expect(f.pushes).toHaveLength(1);
      expect(r.pending.map((b) => [b.pushId, b.baseRev])).toEqual([
        ["push-aaaaaaaaaaaa", 0],
        ["push-bbbbbbbbbbbb", 1],
      ]);
      expect(r.unsent).toEqual([extra]);
      expect(m.read()?.batches).toHaveLength(2);
    }
  });

  it("counts changes the server did not keep", async () => {
    const f = fakeApi();
    const m = new PendingMirror(memory(), SID);
    m.write([{ pushId: "push-stale-000001", baseRev: 0, ops: [put(rect())] }], []);
    f.api.push = async () =>
      ({
        rev: 3,
        versions: {},
        rejected: [{ id: "x", reason: "invalid" }],
        ignored: [
          { id: "y", reason: "stale_replay" },
          { id: "z", reason: "already_deleted" },
        ],
      }) as unknown as Ack;
    expect((await replayMirror(f.api, m)).lost).toBe(2);
  });

  it("applies unsent ops over a snapshot", () => {
    const a = rect();
    const b = rect(5);
    const out = applyOpsToScene(
      [{ el: a, idx: "a0" }],
      [put(b, "a1"), { t: "del", id: a.id, baseVersion: 1 }],
    );
    expect(out.map((e) => e.el.id)).toEqual([b.id]);
  });
});

describe("SyncClient", () => {
  it("saves adds, edits and deletes with the right base versions", async () => {
    const f = fakeApi();
    const h = harness(f.api);
    const a = rect();
    h.set([a]);
    await h.client.settle();
    h.set([{ ...a, x: 50 } as SceneElement]);
    await h.client.settle();
    h.set([]);
    await h.client.settle();
    const ops = f.pushes.flatMap((p) => p.ops);
    expect(ops.map((o) => [o.t, "baseVersion" in o ? o.baseVersion : null])).toEqual([
      ["put", 0],
      ["put", 1],
      ["del", 2],
    ]);
    expect(h.statuses.at(-1)).toBe("saved");
  });

  it("sends one push at a time and mirrors it with its pushId before it leaves", async () => {
    const f = fakeApi();
    const s = memory();
    const h = harness(f.api, s);
    f.hold();
    h.set(Array.from({ length: 700 }, (_, i) => rect(i)));
    h.client.flush();
    await tick();
    expect(f.pushes).toHaveLength(1);
    const mirrored = JSON.parse(s.getItem(mirrorKey(SID))!);
    expect(mirrored.batches[0].pushId).toBe(f.pushes[0].pushId);
    expect(mirrored.unsent).toHaveLength(200);
    // an id edited again while its push is in flight is queued after it
    const first = h.get()[0];
    h.set([{ ...first, x: 999 } as SceneElement, ...h.get().slice(1)]);
    h.client.flush();
    f.release();
    await h.client.settle();
    const again = f.pushes.at(-1)!.ops.find((o) => o.t === "put" && o.el.id === first.id)!;
    expect(again).toMatchObject({ baseVersion: 1 });
    expect(f.pushes.every((p) => p.ops.length <= 500)).toBe(true);
    expect(s.getItem(mirrorKey(SID))).toBeNull();
  });

  it("goes offline on network errors, keeps the batch, and retries the same pushId", async () => {
    const f = fakeApi();
    const h = harness(f.api);
    f.setFail(new ApiError(0, "network", "offline"));
    h.set([rect()]);
    h.client.flush();
    await tick();
    await tick();
    expect(h.statuses).toContain("offline");
    f.setFail(null);
    await h.client.settle();
    const ids = new Set(f.pushes.map((p) => p.pushId));
    expect(ids.size).toBe(1);
    expect(h.statuses.at(-1)).toBe("saved");
  }, 10000);

  it("pagehide sends a small keepalive batch, mirrored first", async () => {
    const f = fakeApi();
    const s = memory();
    const h = harness(f.api, s);
    f.hold();
    h.set(Array.from({ length: 400 }, (_, i) => rect(i)));
    h.client.pageHide();
    await tick();
    expect(f.pushes[0].keepalive).toBe(true);
    expect(jsonBytes(f.pushes[0])).toBeLessThanOrEqual(KEEPALIVE_BYTES);
    const m = JSON.parse(s.getItem(mirrorKey(SID))!);
    expect(m.batches[0].pushId).toBe(f.pushes[0].pushId);
    expect(m.batches[0].ops.length + m.unsent.length).toBe(400);
    f.release();
    await h.client.settle();
  });

  it("refuses an oversized element and keeps the saved version", async () => {
    const f = fakeApi();
    const h = harness(f.api);
    const t = createText(0, 0, DEFAULT_STYLE, "small") as SceneElement;
    h.set([t]);
    await h.client.settle();
    h.set([{ ...t, text: "z".repeat(300 * 1024) } as SceneElement]);
    await h.client.settle();
    expect((h.get()[0] as { text: string }).text).toBe("small");
    expect(h.notices).toHaveLength(1);
    expect(f.pushes).toHaveLength(1);
  });

  it("warns when the mirror cannot protect changes", async () => {
    const f = fakeApi();
    f.hold();
    const h = harness(f.api, fullStorage());
    h.set([rect()]);
    h.client.flush();
    await tick();
    expect(h.warnings.some((w) => w && /not protected/.test(w))).toBe(true);
    f.release();
    await h.client.settle();
  });

  it("stops on a deleted board", async () => {
    const f = fakeApi();
    f.setFail(new ApiError(404, "session_not_found", "gone"));
    const h = harness(f.api);
    h.set([rect()]);
    h.client.flush();
    await tick();
    await tick();
    expect(h.statuses.at(-1)).toBe("gone");
  });
});

describe("Rule D: files are add-only", () => {
  it("undo and redo keep the session's files", () => {
    const s = new Store();
    s.sessionMode = true;
    s.commit([rect()]);
    s.set({ files: { f1: { id: "f1", mimeType: "image/png", dataURL: "/f1" } } });
    expect(s.undo()).toBe(true);
    expect(Object.keys(s.get().files)).toEqual(["f1"]);
    expect(s.redo()).toBe(true);
    expect(Object.keys(s.get().files)).toEqual(["f1"]);
  });
});

describe("session addresses and recent boards", () => {
  it("parses session paths strictly", () => {
    expect(sessionIdFromPath("/")).toBe("root");
    expect(sessionIdFromPath(`/s/${SID}`)).toBe(SID);
    expect(sessionIdFromPath(`/s/${SID}/`)).toBe(SID);
    expect(sessionIdFromPath("/s/short")).toBe("invalid");
    expect(sessionIdFromPath(`/s/${SID}x`)).toBe("invalid");
    expect(sessionIdFromPath(`/x/${SID}`)).toBeNull();
  });

  it("keeps the 20 most recent boards, newest first", () => {
    const s = memory();
    const ids = Array.from(
      { length: 25 },
      (_, i) => `${"A".repeat(22)}${String(i).padStart(2, "0")}`,
    );
    ids.forEach((id, i) => rememberBoard(s, { id, title: `b${i}` }, i));
    const list = readRecent(s);
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0].id).toBe(ids[24]);
    rememberBoard(s, { id: ids[10], title: "again" }, 99);
    expect(readRecent(s)[0]).toMatchObject({ id: ids[10], title: "again" });
    forgetBoard(s, ids[10]);
    expect(readRecent(s).some((r) => r.id === ids[10])).toBe(false);
    s.setItem("chalanamaya.sessions", JSON.stringify([{ id: "bad", title: 1 }, { id: ID2 }]));
    expect(readRecent(s)).toEqual([]);
    expect(boardLabel("  ")).toBe("Untitled board");
    expect(shortId(SID)).toBe("AbCdEf");
  });
});

describe("opening a board while the server refuses replays", () => {
  it("lays pending batches over the snapshot and resends them with their pushIds", async () => {
    const f = fakeApi();
    const s = memory();
    const a = rect();
    const batch: MirrorBatch = { pushId: "pending-push-00001", baseRev: 4, ops: [put(a, "a0", 0)] };
    f.setFail(new ApiError(429, "rate_limited", "slow down"));
    const h = harness(f.api, s, { pending: [batch], elements: [a] });
    // the board opens offline, with the change on it
    h.client.schedule();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.statuses).toContain("offline");
    expect(JSON.parse(s.getItem(mirrorKey(SID))!).batches[0].pushId).toBe(batch.pushId);
    f.setFail(null);
    await h.client.settle();
    // only the mirrored batch went out (no duplicate diff of the same element)
    expect(new Set(f.pushes.map((p) => p.pushId))).toEqual(new Set([batch.pushId]));
    expect(f.pushes.every((p) => p.mirrored === true && p.baseRev === 4)).toBe(true);
    expect(h.statuses.at(-1)).toBe("saved");
    expect(s.getItem(mirrorKey(SID))).toBeNull();
    // a later edit uses the version the server gave the replayed batch
    h.set([{ ...a, x: 70 } as SceneElement]);
    await h.client.settle();
    expect(f.pushes.at(-1)!.ops[0]).toMatchObject({ baseVersion: 1 });
    expect(f.pushes.at(-1)!.mirrored).toBeUndefined();
  }, 10000);

  it("takes the server's version back when a resent batch is stale", async () => {
    const f = fakeApi();
    const a = rect();
    const serverCopy = { ...a, x: 999 } as SceneElement;
    const snap = { ...emptySnap, rev: 9, elements: [{ el: serverCopy, idx: "a0", version: 5 }] };
    f.api.push = async (_id, body) => {
      f.pushes.push(body);
      return {
        pushId: body.pushId,
        rev: 9,
        versions: {},
        rejected: [],
        ignored: [{ id: a.id, reason: "stale_replay" }],
      } as Ack;
    };
    f.api.scene = async () => snap as unknown as SceneSnapshot;
    const h = harness(f.api, memory(), {
      pending: [{ pushId: "pending-stale-0001", baseRev: 1, ops: [put(a, "a0", 1)] }],
      elements: [a],
      snap: snap as unknown as SceneSnapshot,
    });
    await h.client.settle();
    await tick();
    await tick();
    expect(h.notices.some((n) => /not kept/.test(n))).toBe(true);
    expect(h.get()[0].x).toBe(999);
  });
});

describe("save scheduling", () => {
  it("throttles: a continuous drag is pushed and mirrored about every 250 ms, never per frame", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const f = fakeApi();
      const s = memory();
      let writes = 0;
      const counting: StorageLike = {
        getItem: (k) => s.getItem(k),
        setItem: (k, v) => {
          writes += 1;
          s.setItem(k, v);
        },
        removeItem: (k) => s.removeItem?.(k),
      };
      const h = harness(f.api, counting);
      const a = rect();
      // 2 seconds of pointer moves at 60 frames a second
      for (let i = 0; i < 120; i += 1) {
        h.set([{ ...a, x: i } as SceneElement]);
        h.client.schedule();
        await vi.advanceTimersByTimeAsync(1000 / 60);
      }
      expect(f.pushes.length).toBeGreaterThanOrEqual(6);
      expect(f.pushes.length).toBeLessThanOrEqual(10);
      expect(writes).toBeLessThanOrEqual(3 * 10);
      expect(writes).toBeLessThan(120);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a committed history step is written at once", () => {
    const f = fakeApi();
    const store = new Store();
    const h = harness(f.api);
    store.onCommit = () => {
      h.set([...store.get().elements]);
      h.client.flush();
    };
    store.commit([rect()]);
    expect(f.pushes).toHaveLength(1);
  });

  it("pagehide re-dirty uses the in-flight expected version", async () => {
    const f = fakeApi();
    const s = memory();
    const h = harness(f.api, s);
    const a = rect();
    f.hold();
    h.set([a]);
    h.client.flush();
    await tick();
    expect(f.pushes).toHaveLength(1);
    // edited again while the first push is still in flight, then the page goes away
    h.set([{ ...a, x: 42 } as SceneElement]);
    h.client.pageHide();
    const m = JSON.parse(s.getItem(mirrorKey(SID))!);
    expect(m.batches[0].pushId).toBe(f.pushes[0].pushId);
    expect(m.unsent).toHaveLength(1);
    expect(m.unsent[0]).toMatchObject({ t: "put", baseVersion: 1 });
    f.release();
    await h.client.settle();
  });
});

describe("outgoing ops", () => {
  it("moving a box with two connectors sends the box and both connectors only", async () => {
    const { createLinear } = await import("../scene/elements");
    const { moveElements } = await import("../scene/transform");
    const { finalizeScene } = await import("../scene/scene");
    const f = fakeApi();
    const h = harness(f.api);
    const box = { ...rect(0), width: 100, height: 60 } as SceneElement;
    const other = { ...rect(400), width: 100, height: 60 } as SceneElement;
    const far = rect(900);
    const a1 = {
      ...createLinear("arrow", 100, 30, DEFAULT_STYLE, [
        { x: 0, y: 0 },
        { x: 300, y: 0 },
      ]),
      startBinding: { elementId: box.id },
      endBinding: { elementId: other.id },
    } as SceneElement;
    const a2 = {
      ...createLinear("arrow", 400, 50, DEFAULT_STYLE, [
        { x: 0, y: 0 },
        { x: -300, y: 0 },
      ]),
      startBinding: { elementId: other.id },
      endBinding: { elementId: box.id },
    } as SceneElement;
    const start = finalizeScene([box, other, far, a1, a2]);
    h.set(start);
    await h.client.settle();
    f.pushes.length = 0;
    h.set(finalizeScene(moveElements(start, new Set([box.id]), 0, 200)));
    await h.client.settle();
    const ops = f.pushes.flatMap((p) => p.ops);
    expect(ops.every((o) => o.t === "put")).toBe(true);
    expect(new Set(ops.map((o) => (o.t === "put" ? o.el.id : "")))).toEqual(
      new Set([box.id, a1.id, a2.id]),
    );
  });
});

describe("Rule E: the reorder hint is kept in history", () => {
  it("bring to front, undo and redo send the same two ids (box and label)", async () => {
    const { reorderSelected } = await import("../store/actions");
    const f = fakeApi();
    const store = new Store();
    const box = rect(0);
    const label = { ...createText(0, 0, DEFAULT_STYLE, "hi"), containerId: box.id } as SceneElement;
    const top = rect(50);
    store.set({ elements: [box, label, top] });
    let elements: SceneElement[] = [...store.get().elements];
    const client = new SyncClient(
      SID,
      f.api,
      {
        scene: () => ({
          elements,
          settings: { viewBackgroundColor: "#fff9ed", gridEnabled: false, title: "" },
        }),
        replaceElements: (els) => void (elements = els),
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
      emptySnap as never,
    );
    await client.settle();
    store.onSceneChange = () => {
      elements = [...store.get().elements];
      client.schedule();
    };
    const sent = async () => {
      f.pushes.length = 0;
      await client.settle();
      return f.pushes
        .flatMap((p) => p.ops)
        .map((o) => (o.t === "put" ? o.el.id : ""))
        .sort();
    };
    const pair = [box.id, label.id].sort();
    store.set({ selectedIds: new Set([box.id]) });
    expect(reorderSelected(store, "front")).toBe(true);
    expect(await sent()).toEqual(pair);
    expect(store.undo()).toBe(true);
    expect(await sent()).toEqual(pair);
    expect(store.redo()).toBe(true);
    expect(await sent()).toEqual(pair);
  });
});

describe("pictures in pasted and imported data", () => {
  it("a clipboard payload may name same-origin session files; a board file may not", async () => {
    const { parseBoardObject, parseClipboard, serializeClipboard } =
      await import("../io/serialize");
    const { createImage } = await import("../scene/elements");
    const img = createImage(0, 0, 10, 10, "f1") as SceneElement;
    const url = `/api/sessions/${SID}/files/f1`;
    const files = { f1: { id: "f1", mimeType: "image/png", dataURL: url } };
    const payload = parseClipboard(serializeClipboard([img], files));
    expect(payload?.files.f1.dataURL).toBe(url);
    for (const bad of ["https://evil.example/x.png", "/api/sessions/short/files/f1", "/etc/x"])
      expect(
        parseClipboard(
          serializeClipboard([img], { f1: { id: "f1", mimeType: "image/png", dataURL: bad } }),
        ),
      ).toBeNull();
    expect(() =>
      parseBoardObject({ type: "chalana", version: 1, elements: [img], files }),
    ).toThrow();
  });

  it("never fetches a remote URL found in imported data", async () => {
    const { adoptFiles } = await import("./files");
    const { createImage } = await import("../scene/elements");
    const { vi } = await import("vitest");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const img = createImage(0, 0, 10, 10, "f1") as SceneElement;
      const r = await adoptFiles(
        [img],
        { f1: { id: "f1", mimeType: "image/png", dataURL: "https://evil.example/x.png" } },
        {},
        async () => ({ id: "n", url: "/n", mime: "image/png" }),
      );
      expect(r.failed).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("draws only data URLs and session file paths", async () => {
    const { isLoadableImageSrc } = await import("../render/renderScene");
    expect(isLoadableImageSrc("data:image/png;base64,AAAA")).toBe(true);
    expect(isLoadableImageSrc(`/api/sessions/${SID}/files/f1`)).toBe(true);
    expect(isLoadableImageSrc("https://evil.example/x.png")).toBe(false);
    expect(isLoadableImageSrc("//evil.example/x.png")).toBe(false);
  });
});

describe("history", () => {
  it("discard forgets only the newest step it names", async () => {
    const { History } = await import("../scene/history");
    const hist = new History();
    const a = { elements: [], files: {} };
    const b = { elements: [], files: {} };
    hist.record(a);
    hist.discard(b);
    expect(hist.canUndo).toBe(true);
    hist.discard(a);
    expect(hist.canUndo).toBe(false);
  });
});

describe("a refused import", () => {
  it("puts the board back and leaves no empty undo step", async () => {
    const { importIntoSession } = await import("./importBoard");
    const store = new Store();
    const keep = rect();
    store.commit([keep]);
    const steps = () => (store.history.canUndo ? 1 : 0);
    const r = await importIntoSession(
      store,
      { queueImport: () => false } as unknown as SyncClient,
      {
        type: "chalana",
        version: 1,
        source: "",
        elements: [rect(5), rect(6)],
        files: {},
        settings: { viewBackgroundColor: "#123456", theme: "light", gridEnabled: true },
      },
      "replace",
    );
    expect(r.ok).toBe(false);
    expect(store.get().elements.map((e) => e.id)).toEqual([keep.id]);
    expect(store.get().gridEnabled).toBe(false);
    // the only undo step left is the original commit
    expect(steps()).toBe(1);
    expect(store.undo()).toBe(true);
    expect(store.history.canUndo).toBe(false);
  });
});
