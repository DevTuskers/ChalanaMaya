import type { FileMap, SceneElement } from "./types";

export interface Snapshot {
  elements: readonly SceneElement[];
  files: FileMap;
}

/**
 * Snapshot-based undo/redo. `record` stores the state *before* an edit;
 * a new edit after undo clears the redo branch.
 */
export class History {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  constructor(private readonly limit = 200) {}

  record(before: Snapshot) {
    this.undoStack.push(before);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current: Snapshot): Snapshot | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(current);
    return prev;
  }

  redo(current: Snapshot): Snapshot | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(current);
    return next;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
