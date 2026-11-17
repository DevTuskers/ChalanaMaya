/** Session addresses and loading (plan §4.1). */
import { isSessionId } from "../shared/ids";
import type { Op, SceneSnapshot } from "../shared/protocol";
import { getStorage } from "../io/autosave";
import type { Api } from "./api";
import { RemoteGuard, replayMirror } from "./client";
import { PendingMirror, tabLease, type MirrorBatch, type TabLease } from "./mirror";

export interface SessionBoot {
  id: string;
  snapshot: SceneSnapshot;
  /** Ops that were never sent before the last reload; applied over the snapshot. */
  unsent: Op[];
  /**
   * Mirrored batches the server could not take while the board opened; laid
   * over the snapshot and resent by the sync client with their pushIds.
   */
  pending: MirrorBatch[];
  /** Changes from the last visit the server did not keep (0 when all were kept). */
  lost: number;
  /** Counts invalid remote elements; shared with the sync client. */
  guard?: RemoteGuard;
}

/**
 * `"root"` for `/`, the id for `/s/<valid id>`, `"invalid"` for an `/s/...`
 * address whose id is malformed, and null for any other path.
 */
export const sessionIdFromPath = (path: string): string | null | "root" | "invalid" => {
  if (path === "/" || path === "") return "root";
  const m = /^\/s\/([^/]*)\/?$/.exec(path);
  if (!m) return null;
  return isSessionId(m[1]) ? m[1] : "invalid";
};

/**
 * Mirrors of this board left by tabs that are gone (closed or crashed) are
 * adopted, so their offline edits are replayed here instead of being stranded.
 */
export const adoptOrphans = async (mirror: PendingMirror, lease: TabLease) => {
  const foreign = mirror.foreignTabs();
  if (!foreign.length) return [];
  const live = await lease.liveAmong(foreign);
  const orphans = foreign.filter((t) => !live.has(t));
  mirror.adopt(orphans);
  return orphans;
};

export const loadSession = async (api: Api, id: string): Promise<SessionBoot> => {
  const lease = await tabLease();
  const mirror = new PendingMirror(getStorage(), id, undefined, lease.id);
  await adoptOrphans(mirror, lease);
  // never blocks opening the board: undeliverable batches come back as pending
  const { unsent, pending, lost } = await replayMirror(api, mirror);
  // Rule B: elements from the server are checked before anything is shown
  const guard = new RemoteGuard();
  const snapshot = guard.snapshot(await api.scene(id));
  return { id, snapshot, unsent, pending, lost, guard };
};
