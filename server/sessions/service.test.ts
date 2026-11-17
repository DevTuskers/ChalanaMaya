import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type Limits } from "../config";
import { openDatabase } from "../db/schema";
import { ServiceError } from "../errors";
import { createImage, createText } from "../../src/scene/elements";
import { newPushId } from "../../src/shared/ids";
import { injectionCorpus } from "../../src/shared/corpus";
import { GIF, keys, PNG, put, rect, tempDir } from "../test/helpers";
import { SessionService, type ChangesEvent, type PushInput } from "./service";

const BROWSER = { kind: "browser" as const, name: "A browser" };
let dir: string;
let clock = 1_000_000;

const make = (limits: Partial<Limits> = {}) => {
  const db = openDatabase(":memory:");
  return new SessionService(db, {
    limits: { ...DEFAULT_LIMITS, ...limits },
    mediaDir: dir,
    now: () => clock,
  });
};
const push = (ops: unknown[], extra: Partial<PushInput> = {}): PushInput => ({
  pushId: newPushId(),
  baseRev: 0,
  ops: ops as PushInput["ops"],
  ...extra,
});

beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SessionService", () => {
  it("creates sessions with 24-character ids", () => {
    const s = make();
    const { sessionId } = s.create("Plan");
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(s.meta(sessionId)).toMatchObject({ title: "Plan", rev: 0, element_count: 0 });
    expect(() => s.meta("A".repeat(24))).toThrow(ServiceError);
  });

  it("stores valid elements byte-identically with versions", () => {
    const s = make();
    const { sessionId } = s.create();
    const a = rect();
    const r = s.apply(sessionId, push([put(a)]), { origin: BROWSER, atomic: false });
    expect(r.ack.versions).toEqual({ [a.id]: 1 });
    expect(r.ack.rev).toBe(1);
    const snap = s.snapshot(sessionId);
    expect(JSON.stringify(snap.elements[0].el)).toBe(JSON.stringify(a));
    const r2 = s.apply(sessionId, push([put({ ...a, x: 5 }, "a0", 1)]), {
      origin: BROWSER,
      atomic: false,
    });
    expect(r2.ack.versions[a.id]).toBe(2);
    expect(r2.ack.rev).toBe(2);
  });

  it("rejects the injection corpus and changes nothing", () => {
    const s = make();
    const { sessionId } = s.create();
    for (const [el, p] of injectionCorpus()) {
      const r = s.apply(sessionId, push([put(el)]), { origin: BROWSER, atomic: false });
      expect(r.ack.rejected, p).toHaveLength(1);
      expect(r.ack.rejected[0].reason).toBe("invalid");
      expect(r.ack.rejected[0].path).toBe(`ops[0].el.${p}`);
    }
    expect(s.snapshot(sessionId).elements).toHaveLength(0);
    expect(s.meta(sessionId).rev).toBe(0);
  });

  it("rejects bad settings, accepts good ones", () => {
    const s = make();
    const { sessionId } = s.create();
    const bad = s.apply(
      sessionId,
      push([{ t: "settings", settings: { viewBackgroundColor: "red;}</style>" } }]),
      {
        origin: BROWSER,
        atomic: false,
      },
    );
    expect(bad.ack.rejected[0]).toMatchObject({
      reason: "invalid",
      path: "ops[0].settings.viewBackgroundColor",
    });
    s.apply(
      sessionId,
      push([{ t: "settings", settings: { viewBackgroundColor: "#fff9ed", title: "T" } }]),
      {
        origin: BROWSER,
        atomic: false,
      },
    );
    const snap = s.snapshot(sessionId);
    expect(snap.settings).toEqual({ viewBackgroundColor: "#fff9ed" });
    expect(snap.title).toBe("T");
  });

  it("non-atomic applies the good ops; atomic rolls back on one bad op", () => {
    const s = make();
    const { sessionId } = s.create();
    const good = rect();
    const bad = { ...rect(), strokeColor: "red" };
    const r = s.apply(sessionId, push([put(good), put(bad)]), { origin: BROWSER, atomic: false });
    expect(Object.keys(r.ack.versions)).toEqual([good.id]);
    expect(r.ack.rejected).toHaveLength(1);
    const good2 = rect();
    const r2 = s.apply(sessionId, push([put(good2), put(bad)]), { origin: BROWSER, atomic: true });
    expect(r2.applied).toBe(false);
    expect(r2.ack.versions).toEqual({});
    expect(r2.ack.rev).toBe(1);
    expect(s.snapshot(sessionId).elements.map((e) => e.el.id)).toEqual([good.id]);
  });

  it("tombstones: del has a version; a put needs the tombstone version", () => {
    const s = make();
    const { sessionId } = s.create();
    const a = rect();
    s.apply(sessionId, push([put(a)]), { origin: BROWSER, atomic: false });
    const d = s.apply(sessionId, push([{ t: "del", id: a.id, baseVersion: 1 }]), {
      origin: BROWSER,
      atomic: false,
    });
    expect(d.ack.versions[a.id]).toBe(2);
    expect(s.snapshot(sessionId).tombstones).toEqual([{ id: a.id, version: 2 }]);
    const late = s.apply(sessionId, push([put(a, "a0", 1)]), { origin: BROWSER, atomic: false });
    expect(late.ack.rejected[0].reason).toBe("deleted");
    const restore = s.apply(sessionId, push([put(a, "a0", 2)]), { origin: BROWSER, atomic: false });
    expect(restore.ack.versions[a.id]).toBe(3);
    expect(s.snapshot(sessionId).tombstones).toEqual([]);
    const again = s.apply(sessionId, push([{ t: "del", id: "nope", baseVersion: 0 }]), {
      origin: BROWSER,
      atomic: false,
    });
    expect(again.ack.ignored).toEqual([{ id: "nope", reason: "not_found" }]);
  });

  it("refuses bad layer keys", () => {
    const s = make();
    const { sessionId } = s.create();
    const r = s.apply(sessionId, push([put(rect(), "not a key!")]), {
      origin: BROWSER,
      atomic: false,
    });
    expect(r.ack.rejected[0]).toMatchObject({ reason: "invalid", path: "ops[0].idx" });
  });

  it("drops a duplicate pushId without reapplying it", () => {
    const s = make();
    const { sessionId } = s.create();
    const events: ChangesEvent[] = [];
    s.events.on("changes", (e: ChangesEvent) => events.push(e));
    const p = push([put(rect())]);
    const first = s.apply(sessionId, p, { origin: BROWSER, atomic: false });
    const second = s.apply(sessionId, p, { origin: BROWSER, atomic: false });
    expect(second.ack).toEqual({ ...first.ack, duplicate: true });
    expect(s.meta(sessionId).rev).toBe(1);
    expect(events).toHaveLength(1);
  });

  it("a replay below the push_log floor keeps newer edits (stale_replay)", () => {
    const s = make({ pushLogMax: 2 });
    const { sessionId } = s.create();
    const a = rect();
    s.apply(sessionId, push([put(a)]), { origin: BROWSER, atomic: false }); // rev 1, v1
    const p = push([put({ ...a, x: 111 }, "a0", 1)], { baseRev: 1, mirrored: true });
    s.apply(sessionId, p, { origin: BROWSER, atomic: false }); // rev 2, v2
    s.apply(sessionId, push([put({ ...a, x: 222 }, "a0", 2)]), { origin: BROWSER, atomic: false }); // rev 3, v3 (newer edit)
    for (let i = 0; i < 3; i++)
      s.apply(sessionId, push([put(rect(), `a${i + 1}`)]), { origin: BROWSER, atomic: false });
    // P was evicted from push_log; its replay is conditional because baseRev < floor
    const replay = s.apply(sessionId, p, { origin: BROWSER, atomic: false });
    expect(replay.ack.duplicate).toBeUndefined();
    expect(replay.ack.ignored).toEqual([{ id: a.id, reason: "stale_replay" }]);
    const el = s.snapshot(sessionId).elements.find((e) => e.el.id === a.id)!;
    expect(el.el.x).toBe(222);
    const floor = s.db
      .prepare<[string], { f: number }>("SELECT push_log_floor_rev AS f FROM sessions WHERE id = ?")
      .get(sessionId)!.f;
    expect(floor).toBeGreaterThan(1);
    // a mirrored push at or above the floor applies normally
    const fresh = s.apply(
      sessionId,
      push([put({ ...a, x: 333 }, "a0", 1)], { baseRev: floor, mirrored: true }),
      {
        origin: BROWSER,
        atomic: false,
      },
    );
    expect(fresh.ack.versions[a.id]).toBe(4);
  });

  it("purges old push_log rows by age and advances the floor", () => {
    const s = make();
    const { sessionId } = s.create();
    s.apply(sessionId, push([put(rect())]), { origin: BROWSER, atomic: false });
    clock += DEFAULT_LIMITS.pushLogMaxAgeMs + 1;
    s.maintenance();
    const row = s.db
      .prepare<[string], { f: number }>("SELECT push_log_floor_rev AS f FROM sessions WHERE id = ?")
      .get(sessionId)!;
    expect(row.f).toBe(1);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM push_log").get()).toEqual({ n: 0 });
  });

  it("layout corrections only change derived fields of flagged elements", () => {
    const s = make();
    const { sessionId } = s.create();
    const t = createText(0, 0, undefined, "hi");
    s.apply(sessionId, push([put(t)]), { origin: BROWSER, atomic: false });
    const noFlag = s.apply(
      sessionId,
      push([{ ...put({ ...t, width: 99 }, "a0", 1), layout: true }]),
      {
        origin: BROWSER,
        atomic: false,
      },
    );
    expect(noFlag.ack.ignored).toEqual([{ id: t.id, reason: "layout_done" }]);
    s.db.prepare("UPDATE elements SET needs_layout = 1 WHERE id = ?").run(t.id);
    const wrong = s.apply(
      sessionId,
      push([{ ...put({ ...t, text: "bye" }, "a0", 1), layout: true }]),
      {
        origin: BROWSER,
        atomic: false,
      },
    );
    expect(wrong.ack.rejected[0].reason).toBe("layout_not_allowed");
    const ok = s.apply(sessionId, push([{ ...put({ ...t, width: 99 }, "a0", 1), layout: true }]), {
      origin: BROWSER,
      atomic: false,
    });
    expect(ok.ack.versions[t.id]).toBe(2);
    expect(s.snapshot(sessionId).elements[0].needsLayout).toBe(false);
  });

  it("pictures must reference this board's files; poster and fileMeta are set once", () => {
    const s = make();
    const { sessionId } = s.create();
    const other = s.create().sessionId;
    const f = s.addFile(other, PNG, "image/png");
    const img = createImage(0, 0, 10, 10, f.id);
    const r = s.apply(sessionId, push([put(img)]), { origin: BROWSER, atomic: false });
    expect(r.ack.rejected[0]).toMatchObject({ reason: "unknown_file", path: "ops[0].el.fileId" });
    const mine = s.addFile(sessionId, PNG, "image/png");
    const poster = s.addFile(sessionId, GIF, "image/gif");
    expect(
      s.apply(sessionId, push([put({ ...img, fileId: mine.id })]), {
        origin: BROWSER,
        atomic: false,
      }).ack.versions,
    ).toHaveProperty(img.id);
    const p1 = s.apply(
      sessionId,
      push([{ t: "poster", fileId: mine.id, posterFileId: poster.id }]),
      { origin: BROWSER, atomic: false },
    );
    expect(p1.ack.ignored).toEqual([]);
    const p2 = s.apply(
      sessionId,
      push([{ t: "poster", fileId: mine.id, posterFileId: poster.id }]),
      { origin: BROWSER, atomic: false },
    );
    expect(p2.ack.ignored).toEqual([{ id: mine.id, reason: "poster_set" }]);
    const unknown = s.apply(
      sessionId,
      push([{ t: "poster", fileId: mine.id, posterFileId: f.id }]),
      { origin: BROWSER, atomic: false },
    );
    expect(unknown.ack.rejected[0].reason).toBe("unknown_file");
    const meta = s.apply(
      sessionId,
      push([{ t: "fileMeta", fileId: mine.id, width: 5, height: 5 }]),
      { origin: BROWSER, atomic: false },
    );
    expect(meta.ack.ignored).toEqual([{ id: mine.id, reason: "meta_known" }]);
  });

  it("enforces the scene caps", () => {
    const s = make({ maxElements: 2 });
    const { sessionId } = s.create();
    const r = s.apply(sessionId, push([put(rect(), "a0"), put(rect(), "a1"), put(rect(), "a2")]), {
      origin: BROWSER,
      atomic: false,
    });
    expect(Object.keys(r.ack.versions)).toHaveLength(2);
    expect(r.ack.rejected[0].reason).toBe("scene_too_large");
  });

  it("import is atomic, one rev, deduplicated by importId", () => {
    const s = make();
    const { sessionId } = s.create();
    const old = rect();
    s.apply(sessionId, push([put(old)]), { origin: BROWSER, atomic: false });
    const k = keys(50);
    const els = k.map((idx) => ({ el: rect(), idx }));
    const importId = newPushId();
    const r = s.importScene(sessionId, { importId, mode: "replace", elements: els }, BROWSER);
    expect(r.ack.rev).toBe(2);
    expect(Object.keys(r.ack.versions)).toHaveLength(51); // 50 puts + 1 tombstone
    const snap = s.snapshot(sessionId);
    expect(snap.elements).toHaveLength(50);
    expect(snap.tombstones.map((t) => t.id)).toEqual([old.id]);
    expect(
      s.importScene(sessionId, { importId, mode: "replace", elements: els }, BROWSER).ack.duplicate,
    ).toBe(true);
    const bad = s.importScene(
      sessionId,
      {
        importId: newPushId(),
        mode: "add",
        elements: [
          { el: rect(), idx: "b0" },
          { el: { ...rect(), x: "1" }, idx: "b1" },
        ],
      },
      BROWSER,
    );
    expect(bad.applied).toBe(false);
    expect(s.snapshot(sessionId).elements).toHaveLength(50);
  });

  it("an import past the scene caps is 413 scene_too_large", () => {
    const s = make({ maxElements: 3 });
    const { sessionId } = s.create();
    const els = keys(4).map((idx) => ({ el: rect(), idx }));
    expect(() =>
      s.importScene(sessionId, { importId: newPushId(), mode: "add", elements: els }, BROWSER),
    ).toThrow(expect.objectContaining({ status: 413, code: "scene_too_large" }));
    expect(s.meta(sessionId).rev).toBe(0);
  });

  it("quotas: sessions, global media and database size give 507", () => {
    const few = make({ maxSessions: 1 });
    few.create();
    expect(() => few.create()).toThrow(
      expect.objectContaining({ status: 507, code: "too_many_sessions" }),
    );

    const media = make({ maxTotalMediaBytes: PNG.length + 1 });
    const sid = media.create().sessionId;
    media.addFile(sid, PNG, "image/png");
    media.addFile(sid, PNG, "image/png"); // same bytes: same file, no new space
    expect(() => media.addFile(sid, GIF, "image/gif")).toThrow(
      expect.objectContaining({ status: 507, code: "storage_full" }),
    );

    const tiny = make({ maxDbBytes: 1 });
    expect(() => tiny.create()).toThrow(
      expect.objectContaining({ status: 507, code: "storage_full" }),
    );
  });

  it("uploads check type and magic bytes; same bytes are stored once across boards", () => {
    const s = make();
    const a = s.create().sessionId;
    const b = s.create().sessionId;
    expect(() => s.addFile(a, PNG, "image/svg+xml")).toThrow(
      expect.objectContaining({ status: 415 }),
    );
    expect(() => s.addFile(a, GIF, "image/png")).toThrow(expect.objectContaining({ status: 415 }));
    expect(() => s.addFile(a, Buffer.alloc(0), "image/png")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    const fa = s.addFile(a, PNG, "image/png");
    const fb = s.addFile(b, PNG, "image/png");
    expect(fa).toMatchObject({ mime: "image/png", width: 1, height: 1, size: PNG.length });
    expect(fs.readdirSync(dir).filter((n) => !n.endsWith(".tmp"))).toHaveLength(1);
    s.deleteSession(a);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    s.deleteSession(b);
    expect(fs.readdirSync(dir)).toHaveLength(0);
    expect(fb.id).not.toBe("");
  });

  it("maintenance removes never-used boards after 24 h", () => {
    const s = make();
    const empty = s.create().sessionId;
    const used = s.create().sessionId;
    s.apply(used, push([put(rect())]), { origin: BROWSER, atomic: false });
    clock += 25 * 3600_000;
    s.maintenance();
    expect(() => s.meta(empty)).toThrow(ServiceError);
    expect(s.meta(used).element_count).toBe(1);
  });
});
