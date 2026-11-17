/**
 * Layer keys (Rule E, plan §3.5): every element carries a fractional key and the
 * layer order is the key order. A reorder only rewrites the keys of the moved
 * elements, so two people moving different items never clash.
 */
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export type LayerHint = {
  kind: "front" | "back" | "forward" | "backward" | "move";
  ids: Iterable<string>;
};

/** Keys longer than this trigger a fresh, evenly spread set. */
export const MAX_KEY_LENGTH = 48;

/** Longest strictly increasing run of existing keys (indices into `keys`), patience sort. */
const keepIndices = (keys: (string | null)[]): Set<number> => {
  const tails: number[] = [];
  const prevIdx = new Array<number>(keys.length).fill(-1);
  keys.forEach((k, i) => {
    if (k === null) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((keys[tails[mid]] as string) < k) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prevIdx[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const out = new Set<number>();
  let i = tails.length ? tails[tails.length - 1] : -1;
  while (i >= 0) {
    out.add(i);
    i = prevIdx[i];
  }
  return out;
};

/**
 * Keys for `next` (bottom to top). Existing keys are kept wherever they are
 * already in order; moved (hinted), new and duplicate-keyed elements get fresh
 * keys between their neighbours. Returns a new map covering exactly `next`.
 */
export const assignKeys = (
  prev: readonly { id: string }[],
  next: readonly { id: string }[],
  keys: ReadonlyMap<string, string>,
  hint?: LayerHint,
): Map<string, string> => {
  const moved = new Set(hint?.ids ?? []);
  const known = new Set(prev.map((e) => e.id));
  const seen = new Set<string>();
  const candidate = next.map((e) => {
    const k = keys.get(e.id);
    if (k === undefined || moved.has(e.id) || !known.has(e.id) || seen.has(k)) return null;
    seen.add(k);
    return k;
  });
  const out = new Map<string, string>();
  if (candidate.some((k) => k !== null && k.length > MAX_KEY_LENGTH)) {
    const fresh = generateNKeysBetween(null, null, next.length);
    next.forEach((e, i) => out.set(e.id, fresh[i]));
    return out;
  }
  const keep = keepIndices(candidate);
  let i = 0;
  let lower: string | null = null;
  while (i < next.length) {
    if (keep.has(i)) {
      lower = candidate[i];
      out.set(next[i].id, lower!);
      i += 1;
      continue;
    }
    let j = i;
    while (j < next.length && !keep.has(j)) j += 1;
    const upper = j < next.length ? candidate[j] : null;
    const fresh = generateNKeysBetween(lower, upper, j - i);
    for (let n = i; n < j; n += 1) out.set(next[n].id, fresh[n - i]);
    lower = fresh[fresh.length - 1];
    i = j;
  }
  return out;
};

/** A key above every key in `keys` (new elements go on top). */
export const keyAbove = (keys: Iterable<string>) => {
  let max: string | null = null;
  for (const k of keys) if (max === null || k > max) max = k;
  return generateKeyBetween(max, null);
};

/** Element ids sorted by key (ties broken by id, as on the server). */
export const orderByKey = <T extends { id: string }>(
  items: readonly T[],
  keys: ReadonlyMap<string, string>,
) =>
  [...items].sort((a, b) => {
    const ka = keys.get(a.id) ?? "";
    const kb = keys.get(b.id) ?? "";
    return ka < kb ? -1 : ka > kb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
