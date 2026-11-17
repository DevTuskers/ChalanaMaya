/**
 * Splitting a save into pushes (plan §4.1): at most 500 ops and 1.5 MB of
 * JSON per push. A container travels with its bound labels whenever the group
 * fits, so a reload never shows a label without its box.
 */
import { LIMITS } from "../shared/limits";
import type { Op } from "../shared/protocol";
import { validateStoredElement } from "../shared/validate";
import type { SceneElement } from "../scene/types";

export const MAX_CHUNK_OPS = 500;
export const MAX_CHUNK_BYTES = 1.5 * 1024 * 1024;
/** Budget of the pagehide keepalive request (browsers allow about 64 KB). */
/** Room kept for the push envelope (pushId, baseRev, brackets). */
export const ENVELOPE_BYTES = 1024;
export const KEEPALIVE_BYTES = 60 * 1024;

const utf8 = new TextEncoder();
export const jsonBytes = (v: unknown) => utf8.encode(JSON.stringify(v)).length;

/** Why an element cannot be saved, or null when the server will take it. */
export const refuseReason = (el: SceneElement): string | null => {
  const v = validateStoredElement(el);
  if (!v.ok) return `${v.path}: ${v.reason}`;
  if (jsonBytes(el) > LIMITS.elementBytes)
    return `it is larger than ${Math.round(LIMITS.elementBytes / 1024)} KB`;
  return null;
};

const opId = (op: Op): string | null => (op.t === "put" ? op.el.id : op.t === "del" ? op.id : null);

/** Groups ops so a bound label directly follows its container's op. */
const groupOps = (ops: readonly Op[]): Op[][] => {
  const groups: Op[][] = [];
  const byId = new Map<string, Op[]>();
  const labels: Op[] = [];
  for (const op of ops) {
    if (op.t === "put" && op.el.type === "text" && op.el.containerId) {
      labels.push(op);
      continue;
    }
    const g = [op];
    groups.push(g);
    const id = opId(op);
    if (id) byId.set(id, g);
  }
  for (const op of labels) {
    const container = op.t === "put" && op.el.type === "text" ? op.el.containerId : null;
    const g = container ? byId.get(container) : undefined;
    if (g) g.push(op);
    else groups.push([op]);
  }
  return groups;
};

/** Packs ops into chunks of at most `maxOps` ops and `maxBytes` bytes of ops JSON. */
export const chunkOps = (
  ops: readonly Op[],
  maxOps = MAX_CHUNK_OPS,
  maxBytes = MAX_CHUNK_BYTES - ENVELOPE_BYTES,
): Op[][] => {
  const chunks: Op[][] = [];
  let cur: Op[] = [];
  let bytes = 0;
  const close = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
    bytes = 0;
  };
  const add = (op: Op, b: number) => {
    if (cur.length + 1 > maxOps || (cur.length && bytes + b > maxBytes)) close();
    cur.push(op);
    bytes += b + 1;
  };
  for (const g of groupOps(ops)) {
    const sizes = g.map(jsonBytes);
    const total = sizes.reduce((a, b) => a + b + 1, 0);
    const fits = g.length <= maxOps && total <= maxBytes;
    if (fits && (cur.length + g.length > maxOps || bytes + total > maxBytes)) close();
    g.forEach((op, i) => add(op, sizes[i]));
  }
  close();
  return chunks;
};
