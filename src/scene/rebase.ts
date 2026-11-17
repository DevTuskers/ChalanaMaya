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
}

/**
 * Log of remote changes so undo/redo snapshots can be brought forward lazily:
 * a snapshot taken at sequence `seq` is rebased by replaying later remote
 * changes only when it is restored.
 */
export class RemoteLog {
  private entries: { seq: number; change: RemoteChange }[] = [];
  private seq = 0;

  constructor(private readonly limit = 500) {}

  get head() {
    return this.seq;
  }

  append(change: RemoteChange): number {
    this.seq += 1;
    this.entries.push({ seq: this.seq, change });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    return this.seq;
  }

  /** True when every change after `seq` is still in the log. */
  covers(seq: number) {
    return seq >= this.seq || (this.entries.length > 0 && this.entries[0].seq <= seq + 1);
  }

  /** Applies remote changes after `seq` to `elements`, keeping untouched objects. */
  rebase(elements: Elements, seq: number): SceneElement[] {
    let out = elements as SceneElement[];
    for (const { seq: s, change } of this.entries) {
      if (s <= seq) continue;
      const del = new Set(change.deletes);
      const up = new Map(change.upserts.map((e) => [e.id, e]));
      const seen = new Set<string>();
      const next: SceneElement[] = [];
      for (const el of out) {
        if (del.has(el.id)) continue;
        seen.add(el.id);
        next.push(up.get(el.id) ?? el);
      }
      for (const el of change.upserts) if (!seen.has(el.id) && !del.has(el.id)) next.push(el);
      out = next;
    }
    return out;
  }
}
