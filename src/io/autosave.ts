import type { FileMap, SceneElement } from "../scene/types";
import { parseBoard, serializeBoard, type BoardSettings, type ChalanaFile } from "./serialize";

export const STORAGE_KEY = "chalanamaya.board.v1";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
  /** key enumeration (localStorage has it; used to find other tabs' mirrors) */
  readonly length?: number;
  key?(index: number): string | null;
}

export const getStorage = (): StorageLike | null => {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
};

/** Writes the board; returns an error message on failure instead of throwing. */
export const saveToStorage = (
  storage: StorageLike | null,
  elements: readonly SceneElement[],
  files: FileMap,
  settings: BoardSettings,
): string | null => {
  if (!storage) return "This browser does not allow local storage.";
  try {
    storage.setItem(STORAGE_KEY, serializeBoard(elements, files, settings));
    return null;
  } catch (err) {
    const quota =
      err instanceof DOMException &&
      (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");
    return quota
      ? "Browser storage is full, so the latest changes were not saved locally."
      : "The board could not be saved to browser storage.";
  }
};

/** Where an unreadable saved board is kept so the next autosave doesn't destroy it. */
export const BACKUP_KEY = "chalanamaya.board.unreadable";

export const loadFromStorage = (storage: StorageLike | null): ChalanaFile | null => {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return parseBoard(raw);
  } catch {
    if (raw) {
      try {
        storage.setItem(BACKUP_KEY, raw);
      } catch {
        // nothing more we can do; the board starts empty
      }
    }
    return null;
  }
};
