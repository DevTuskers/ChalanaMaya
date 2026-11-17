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
import { MIRROR_CAP, PendingMirror, compactMirror, fitMirror, mirrorKey } from "./mirror";
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

const harness = (api: Api, storage: StorageLike = memory()) => {
  let elements: SceneElement[] = [];
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
    emptySnap as never,
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
    const unsent = await replayMirror(f.api, m);
    expect(f.pushes.map((p) => [p.pushId, p.baseRev, p.mirrored])).toEqual([
      ["push-one", 2, true],
      ["push-two", 3, true],
    ]);
    expect(unsent).toEqual([extra]);
  });

  it("keeps the mirror when the network is down", async () => {
    const f = fakeApi();
    f.setFail(new ApiError(0, "network", "offline"));
    const m = new PendingMirror(memory(), SID);
    m.write([{ pushId: "p", baseRev: 0, ops: [put(rect())] }], []);
    await expect(replayMirror(f.api, m)).rejects.toBeInstanceOf(ApiError);
    expect(m.read()?.batches).toHaveLength(1);
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
    expect(sessionIdFromPath("/s/short")).toBeNull();
    expect(sessionIdFromPath(`/s/${SID}x`)).toBeNull();
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
