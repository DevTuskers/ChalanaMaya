import type { FileMap, SceneElement } from "./types";

export interface Snapshot {
  elements: readonly SceneElement[];
  files: FileMap;
  /**
   * Ids the step from this snapshot to the next state moved in the layer
   * order (a reorder hint). Undo and redo of that step send the same ids.
   */
  moves?: readonly string[];
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
    this.redoStack.push(prev.moves ? { ...current, moves: prev.moves } : current);
    return prev;
  }

  redo(current: Snapshot): Snapshot | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(next.moves ? { ...current, moves: next.moves } : current);
    return next;
  }

  /** Forgets `before` when it is the newest undo step (an edit that did not happen). */
  discard(before: Snapshot) {
    if (this.undoStack.at(-1) === before) this.undoStack.pop();
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
