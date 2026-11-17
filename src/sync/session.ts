/** Session addresses and loading (plan §4.1). */
import { isSessionId } from "../shared/ids";
import type { Op, SceneSnapshot } from "../shared/protocol";
import { getStorage } from "../io/autosave";
import type { Api } from "./api";
import { replayMirror } from "./client";
import { PendingMirror, type MirrorBatch } from "./mirror";

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

export const loadSession = async (api: Api, id: string): Promise<SessionBoot> => {
  const mirror = new PendingMirror(getStorage(), id);
  // never blocks opening the board: undeliverable batches come back as pending
  const { unsent, pending, lost } = await replayMirror(api, mirror);
  const snapshot = await api.scene(id);
  return { id, snapshot, unsent, pending, lost };
};
