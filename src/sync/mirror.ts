/**
 * The pending mirror (plan §4.1): every push that has not been acknowledged
 * is kept in localStorage with its original pushId and baseRev, plus the ops
 * not yet sent. After a reload the batches are replayed in order (the server
 * recognises a pushId it already applied, and a `mirrored` replay older than
 * its push log never overwrites newer edits), then the unsent ops are applied
 * on top and saved normally. Import bodies and file bytes are never mirrored.
 */
import type { Op } from "../shared/protocol";
import type { StorageLike } from "../io/autosave";

export interface MirrorBatch {
  pushId: string;
  baseRev: number;
  ops: Op[];
}

export interface MirrorData {
  v: 1;
  batches: MirrorBatch[];
  unsent: Op[];
}

export const MIRROR_CAP = 2 * 1024 * 1024;
export const mirrorKey = (sessionId: string) => `chalanamaya.pending.${sessionId}`;

const opKey = (op: Op): string =>
  op.t === "put"
    ? `e:${op.el.id}`
    : op.t === "del"
      ? `e:${op.id}`
      : op.t === "settings"
        ? `s:${Object.keys(op.settings).sort().join(",")}`
        : `f:${op.t}:${op.fileId}`;

/**
 * Keeps only the newest op per element (and per settings field set) across
 * the batches and the unsent ops. Retained ops keep their batch, so their
 * original pushId and baseRev are still used.
 */
export const compactMirror = (data: MirrorData): MirrorData => {
  const seen = new Set<string>();
  const keep = (ops: Op[]) => {
    const out: Op[] = [];
    for (let i = ops.length - 1; i >= 0; i -= 1) {
      const k = opKey(ops[i]);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(ops[i]);
    }
    return out.reverse();
  };
  const unsent = keep(data.unsent);
  const batches: MirrorBatch[] = [];
  for (let i = data.batches.length - 1; i >= 0; i -= 1) {
    const ops = keep(data.batches[i].ops);
    if (ops.length) batches.unshift({ ...data.batches[i], ops });
  }
  return { v: 1, batches, unsent };
};

export type MirrorWrite =
  | { ok: true; complete: true }
  | { ok: true; complete: false; dropped: number }
  | { ok: false; reason: string };

/** Serialised length of one op; ops are reused between writes, so this is cached. */
const opLength = new WeakMap<Op, number>();
const lengthOf = (op: Op) => {
  let n = opLength.get(op);
  if (n === undefined) {
    n = JSON.stringify(op).length;
    opLength.set(op, n);
  }
  return n;
};

/** Exact serialised length of `data`, from cached op lengths. */
export const mirrorSize = (data: MirrorData) => {
  const list = (ops: Op[]) =>
    ops.reduce((a, o) => a + lengthOf(o), 0) + Math.max(0, ops.length - 1) + 2;
  let n = '{"v":1,"batches":[],"unsent":}'.length + list(data.unsent);
  data.batches.forEach((b, i) => {
    n += JSON.stringify({ ...b, ops: [] }).length - 2 + list(b.ops) + (i ? 1 : 0);
  });
  return n;
};

/**
 * Fits the data under `cap` characters: compacts, then drops the oldest ops.
 * Sizes come from cached per-op lengths, so a long drag over a large board
 * does not stringify megabytes of ops many times on every write.
 */
export const fitMirror = (
  data: MirrorData,
  cap = MIRROR_CAP,
): { data: MirrorData; text: string; dropped: number } => {
  if (mirrorSize(data) <= cap) return { data, text: JSON.stringify(data), dropped: 0 };
  let d = compactMirror(data);
  let size = mirrorSize(d);
  let dropped = 0;
  if (size > cap) {
    const batches = d.batches.map((b) => ({ ...b, ops: [...b.ops] }));
    const unsent = [...d.unsent];
    while (size > cap && (batches.length || unsent.length)) {
      const b = batches[0];
      const ops = b ? b.ops : unsent;
      const op = ops.shift();
      if (op) {
        dropped += 1;
        size -= lengthOf(op) + (ops.length ? 1 : 0);
      }
      if (b && !b.ops.length) {
        batches.shift();
        size = mirrorSize({ v: 1, batches, unsent });
      }
    }
    d = { v: 1, batches, unsent };
  }
  return { data: d, text: JSON.stringify(d), dropped };
};

export class PendingMirror {
  constructor(
    private readonly storage: StorageLike | null,
    readonly sessionId: string,
    private readonly cap = MIRROR_CAP,
  ) {}

  read(): MirrorData | null {
    try {
      const raw = this.storage?.getItem(mirrorKey(this.sessionId));
      if (!raw) return null;
      const d = JSON.parse(raw) as Partial<MirrorData>;
      if (!d || d.v !== 1 || !Array.isArray(d.batches) || !Array.isArray(d.unsent)) return null;
      const batches = d.batches.filter(
        (b): b is MirrorBatch =>
          !!b &&
          typeof b.pushId === "string" &&
          typeof b.baseRev === "number" &&
          Array.isArray(b.ops),
      );
      return { v: 1, batches, unsent: d.unsent };
    } catch {
      return null;
    }
  }

  /** Never throws: a full or missing storage is reported, not raised. */
  write(batches: MirrorBatch[], unsent: Op[]): MirrorWrite {
    if (!this.storage) return { ok: false, reason: "this browser has no local storage" };
    const key = mirrorKey(this.sessionId);
    try {
      if (!batches.length && !unsent.length) {
        this.storage.removeItem?.(key);
        return { ok: true, complete: true };
      }
      const fitted = fitMirror({ v: 1, batches, unsent }, this.cap);
      this.storage.setItem(key, fitted.text);
      return fitted.dropped
        ? { ok: true, complete: false, dropped: fitted.dropped }
        : { ok: true, complete: true };
    } catch {
      return { ok: false, reason: "the browser's local storage is full" };
    }
  }

  clear() {
    try {
      this.storage?.removeItem?.(mirrorKey(this.sessionId));
    } catch {
      // nothing to protect
    }
  }
}
