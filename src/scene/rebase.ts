/**
 * Rule C building blocks (plan §3.3): gestures and history computed against the
 * current scene by id, so remote changes arriving mid-gesture are kept.
 * Nothing here talks to a server; phase 1b wires it to live sync.
 */
import { withDependents } from "./arrange";
import type { Elements } from "./scene";
import type { SceneElement } from "./types";

/** Start copies of what a move/resize/rotate will change, kept by id. */
export interface InteractionBase {
  ids: ReadonlySet<string>;
  start: ReadonlyMap<string, SceneElement>;
}

export const captureInteraction = (elements: Elements, ids: Iterable<string>): InteractionBase => {
  const idSet = new Set(ids);
  const affected = withDependents(elements, idSet);
  const start = new Map<string, SceneElement>();
  for (const el of elements) if (affected.has(el.id)) start.set(el.id, el);
  return { ids: idSet, start };
};

/**
 * The scene a gesture step is computed from: the current scene with the
 * gesture's elements put back at their start state. Elements deleted meanwhile
 * stay deleted; everything else is the live version.
 */
export const interactionScene = (current: Elements, base: InteractionBase): SceneElement[] =>
  current.map((e) => base.start.get(e.id) ?? e);

/** Gesture ids that still exist in the current scene. */
export const liveIds = (current: Elements, base: InteractionBase): Set<string> => {
  const present = new Set(current.map((e) => e.id));
  return new Set([...base.ids].filter((id) => present.has(id)));
};

/**
 * Reapplies local edits (local vs base) on top of a newer remote scene.
 * Unchanged elements keep the remote object; elements deleted locally are
 * removed; elements created locally are appended. Returns `remote` itself when
 * nothing local changed.
 */
export const rebaseElements = (
  base: Elements,
  local: Elements,
  remote: Elements,
): SceneElement[] => {
  if (local === base) return remote as SceneElement[];
  const baseMap = new Map(base.map((e) => [e.id, e]));
  const localMap = new Map(local.map((e) => [e.id, e]));
  const edits = new Map<string, SceneElement>();
  const deleted = new Set<string>();
  for (const el of local) if (baseMap.get(el.id) !== el) edits.set(el.id, el);
  for (const el of base) if (!localMap.has(el.id)) deleted.add(el.id);
  if (!edits.size && !deleted.size) return remote as SceneElement[];
  const out: SceneElement[] = [];
  const placed = new Set<string>();
  for (const el of remote) {
    if (deleted.has(el.id)) continue;
    out.push(edits.get(el.id) ?? el);
    placed.add(el.id);
  }
  for (const [id, el] of edits) if (!placed.has(id) && !baseMap.has(id)) out.push(el);
  return out;
};

/** One remote change: upserted elements by id and deleted ids, in scene order. */
export interface RemoteChange {
  upserts: readonly SceneElement[];
  deletes: readonly string[];
  /** Layer keys of the upserts (Rule E); an upsert with a key is placed by it. */
  keys?: ReadonlyMap<string, string>;
}

const before = (ka: string, ia: string, kb: string, ib: string) =>
  ka < kb || (ka === kb && ia < ib);

/**
 * Applies one remote change to a scene by id (Rule B): deletes drop out,
 * upserts replace the element with that id, and an upsert with a layer key
 * is placed by key among the elements around it (`keyOf` gives their keys;
 * an element without a key stays right after its predecessor). Returns the
 * same array when nothing changes.
 */
export const applyChange = (
  elements: Elements,
  change: RemoteChange,
  keyOf: (id: string) => string | undefined = () => undefined,
): SceneElement[] => {
  if (!change.upserts.length && !change.deletes.length) return elements as SceneElement[];
  const del = new Set(change.deletes);
  const keys = change.keys;
  const inPlace = new Map<string, SceneElement>();
  const placed: { el: SceneElement; key: string }[] = [];
  for (const u of change.upserts) {
    if (del.has(u.id)) continue;
    const k = keys?.get(u.id);
    if (k !== undefined) placed.push({ el: u, key: k });
    else inPlace.set(u.id, u);
  }
  const reinsert = new Set(placed.map((p) => p.el.id));
  placed.sort((a, b) => (before(a.key, a.el.id, b.key, b.el.id) ? -1 : 1));
  const out: SceneElement[] = [];
  const seen = new Set<string>();
  let j = 0;
  let changed = false;
  for (const el of elements) {
    if (del.has(el.id) || reinsert.has(el.id)) {
      changed = true;
      continue;
    }
    const k = keys?.get(el.id) ?? keyOf(el.id);
    if (k !== undefined)
      while (j < placed.length && before(placed[j].key, placed[j].el.id, k, el.id))
        out.push(placed[j++].el);
    const u = inPlace.get(el.id);
    if (u) {
      seen.add(el.id);
      if (u !== el) changed = true;
      out.push(u);
    } else out.push(el);
  }
  while (j < placed.length) out.push(placed[j++].el);
  for (const [id, u] of inPlace)
    if (!seen.has(id)) {
      out.push(u);
      changed = true;
    }
  if (!changed && !placed.length) return elements as SceneElement[];
  return out;
};
