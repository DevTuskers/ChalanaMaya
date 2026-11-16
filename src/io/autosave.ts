import type { FileMap, SceneElement } from "../scene/types";
import { parseBoard, serializeBoard, type BoardSettings, type ChalanaFile } from "./serialize";

export const STORAGE_KEY = "chalanamaya.board.v1";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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

export const loadFromStorage = (storage: StorageLike | null): ChalanaFile | null => {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return parseBoard(raw);
  } catch {
    return null;
  }
};
