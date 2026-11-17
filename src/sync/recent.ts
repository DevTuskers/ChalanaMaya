/** Recently opened boards, kept in this browser only (plan §4.1, session menu). */
import { isSessionId } from "../shared/ids";
import type { StorageLike } from "../io/autosave";

export const RECENT_KEY = "chalanamaya.sessions";
export const RECENT_MAX = 20;

export interface RecentBoard {
  id: string;
  title: string;
  openedAt: number;
}

export const readRecent = (storage: StorageLike | null): RecentBoard[] => {
  try {
    const raw = JSON.parse(storage?.getItem(RECENT_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (r): r is RecentBoard =>
          !!r &&
          isSessionId((r as RecentBoard).id) &&
          typeof (r as RecentBoard).title === "string" &&
          typeof (r as RecentBoard).openedAt === "number",
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
};

/** Moves a board to the top of the list (at most RECENT_MAX are kept). */
export const rememberBoard = (
  storage: StorageLike | null,
  board: { id: string; title: string },
  now = Date.now(),
): RecentBoard[] => {
  const list = [
    { id: board.id, title: board.title.slice(0, 120), openedAt: now },
    ...readRecent(storage).filter((r) => r.id !== board.id),
  ].slice(0, RECENT_MAX);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // the list is a convenience
  }
  return list;
};

export const forgetBoard = (storage: StorageLike | null, id: string) => {
  const list = readRecent(storage).filter((r) => r.id !== id);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // the list is a convenience
  }
  return list;
};

/** "Untitled board" for an empty title; otherwise the title. */
export const boardLabel = (title: string) => title.trim() || "Untitled board";

/** The first 6 characters of a session id, as shown in the menu. */
export const shortId = (id: string) => id.slice(0, 6);
