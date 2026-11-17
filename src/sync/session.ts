/** Session addresses and loading (plan §4.1). */
import { isSessionId } from "../shared/ids";
import type { Op, SceneSnapshot } from "../shared/protocol";
import { getStorage } from "../io/autosave";
import type { Api } from "./api";
import { replayMirror } from "./client";
import { PendingMirror } from "./mirror";

export interface SessionBoot {
  id: string;
  snapshot: SceneSnapshot;
  /** Ops that were never sent before the last reload; applied over the snapshot. */
  unsent: Op[];
}

export const sessionIdFromPath = (path: string): string | null | "root" => {
  if (path === "/" || path === "") return "root";
  const m = /^\/s\/([^/]+)\/?$/.exec(path);
  return m && isSessionId(m[1]) ? m[1] : null;
};

export const loadSession = async (api: Api, id: string): Promise<SessionBoot> => {
  const mirror = new PendingMirror(getStorage(), id);
  const unsent = await replayMirror(api, mirror);
  const snapshot = await api.scene(id);
  return { id, snapshot, unsent };
};
