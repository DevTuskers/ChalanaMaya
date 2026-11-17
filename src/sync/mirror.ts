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

/** Fits the data under `cap` characters: compacts, then drops the oldest ops. */
export const fitMirror = (
  data: MirrorData,
  cap = MIRROR_CAP,
): { data: MirrorData; text: string; dropped: number } => {
  let text = JSON.stringify(data);
  if (text.length <= cap) return { data, text, dropped: 0 };
  let d = compactMirror(data);
  text = JSON.stringify(d);
  let dropped = 0;
  while (text.length > cap && (d.batches.length || d.unsent.length)) {
    const b = d.batches[0];
    if (b) {
      const n = Math.max(1, Math.ceil(b.ops.length / 4));
      dropped += Math.min(n, b.ops.length);
      const ops = b.ops.slice(n);
      d = {
        ...d,
        batches: ops.length ? [{ ...b, ops }, ...d.batches.slice(1)] : d.batches.slice(1),
      };
    } else {
      const n = Math.max(1, Math.ceil(d.unsent.length / 4));
      dropped += Math.min(n, d.unsent.length);
      d = { ...d, unsent: d.unsent.slice(n) };
    }
    text = JSON.stringify(d);
  }
  return { data: d, text, dropped };
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
