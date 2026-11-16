import { DEFAULT_STYLE, PAPER } from "../scene/constants";
import { History, type Snapshot } from "../scene/history";
import { finalizeScene } from "../scene/scene";
import type { FileMap, ItemStyle, SceneElement, Theme, Viewport } from "../scene/types";

export type ToolId =
  | "pick"
  | "lasso"
  | "rectangle"
  | "diamond"
  | "ellipse"
  | "arrow"
  | "line"
  | "freedraw"
  | "text"
  | "note"
  | "frame"
  | "eraser"
  | "eyedropper"
  | "hand";

export type InputPreference = "mouse" | "trackpad";

export interface Preferences {
  penMode: boolean;
  inputPreference: InputPreference;
  snapping: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  penMode: false,
  inputPreference: "trackpad",
  snapping: true,
};

export type Dialog =
  | { kind: "help" }
  | { kind: "export" }
  | { kind: "svg" }
  | { kind: "link"; elementId: string }
  | { kind: "openLink"; url: string }
  | { kind: "settings" }
  | { kind: "clear" }
  | { kind: "confirmOpen"; fileName: string; apply: () => void }
  | null;

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "error" | "success";
  /** Optional one-click command shown in the notice. */
  action?: { label: string; testId?: string; run: () => void };
}

export interface AppState {
  elements: readonly SceneElement[];
  files: FileMap;
  selectedIds: ReadonlySet<string>;
  tool: ToolId;
  viewport: Viewport;
  theme: Theme;
  currentStyle: ItemStyle;
  editingTextId: string | null;
  dialog: Dialog;
  menuOpen: boolean;
  toasts: Toast[];
  storageWarning: string | null;
  /** Bumped whenever history changes so the UI can refresh undo/redo state. */
  historyVersion: number;
  /** Keep drawing: drawing tools stay active after finishing an item. */
  toolLocked: boolean;
  gridEnabled: boolean;
  /** Board colour id (light value; dark theme shows a matching variant). */
  viewBackgroundColor: string;
  zenMode: boolean;
  viewMode: boolean;
  statsOpen: boolean;
  searchOpen: boolean;
  prefs: Preferences;
  /** Style copied with "Copy styles". */
  copiedStyle: Partial<ItemStyle> | null;
  /** Lasso path or eraser trail in board units, drawn on the overlay. */
  trail: { kind: "lasso" | "eraser"; points: { x: number; y: number }[] } | null;
  /** Elements about to be erased. */
  pendingErase: ReadonlySet<string>;
  /** Snap guides currently shown, in board units. */
  snapLines: { x1: number; y1: number; x2: number; y2: number }[];
  /** Image being cropped. */
  croppingId: string | null;
  /** Arrow or line whose points are being edited. */
  editingPointsId: string | null;
  editingPointIndex: number | null;
  /** Which colour the eyedropper fills in. */
  eyedropperTarget: "strokeColor" | "backgroundColor";
  /** Tool to return to when the eyedropper finishes. */
  toolBeforeEyedropper: ToolId;
  /** Element id highlighted by search. */
  searchHighlight: string | null;
}

export const initialState = (): AppState => ({
  elements: [],
  files: {},
  selectedIds: new Set(),
  tool: "pick",
  viewport: { scrollX: 0, scrollY: 0, zoom: 1 },
  theme: "light",
  currentStyle: { ...DEFAULT_STYLE },
  editingTextId: null,
  dialog: null,
  menuOpen: false,
  toasts: [],
  storageWarning: null,
  historyVersion: 0,
  toolLocked: false,
  gridEnabled: false,
  viewBackgroundColor: PAPER.light,
  zenMode: false,
  viewMode: false,
  statsOpen: false,
  searchOpen: false,
  prefs: { ...DEFAULT_PREFERENCES },
  copiedStyle: null,
  trail: null,
  pendingErase: new Set(),
  snapLines: [],
  croppingId: null,
  editingPointsId: null,
  editingPointIndex: null,
  eyedropperTarget: "strokeColor",
  toolBeforeEyedropper: "pick",
  searchHighlight: null,
});

type Listener = () => void;

/** Small observable store; components read it with useSyncExternalStore. */
export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();
  readonly history = new History();
  private toastId = 0;
  /** Called after any change to elements/files (autosave hook). */
  onSceneChange: (() => void) | null = null;
  /** CSS-pixel size of the canvas, kept current by the canvas component. */
  viewSize = { width: 1024, height: 768 };
  /** Window hosting the app (set on mount), used for opening links. */
  ownerWindow: Window | null = null;
  /** Last pointer position over the canvas, in screen px. */
  lastPointer: { x: number; y: number } | null = null;

  constructor(state: AppState = initialState()) {
    this.state = state;
  }

  get = () => this.state;

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  set(patch: Partial<AppState>) {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    if (patch.elements !== undefined || patch.files !== undefined) {
      if (patch.elements !== undefined && patch.elements !== prev.elements) {
        // keep selection valid when elements disappear
        const ids = new Set(this.state.elements.map((e) => e.id));
        const sel = [...this.state.selectedIds].filter((id) => ids.has(id));
        if (sel.length !== this.state.selectedIds.size) this.state.selectedIds = new Set(sel);
      }
      this.onSceneChange?.();
    }
    this.listeners.forEach((l) => l());
  }

  snapshot(): Snapshot {
    return { elements: this.state.elements, files: this.state.files };
  }

  /** Records the current scene in history, then applies new elements. */
  commit(elements: readonly SceneElement[], extra: Partial<AppState> = {}) {
    this.history.record(this.snapshot());
    this.set({
      ...extra,
      elements: finalizeScene(elements),
      historyVersion: this.state.historyVersion + 1,
    });
  }

  /** Records a snapshot taken earlier (e.g. at the start of a drag). */
  commitFrom(before: Snapshot, extra: Partial<AppState> = {}) {
    if (before.elements === this.state.elements && before.files === this.state.files) {
      if (Object.keys(extra).length) this.set(extra);
      return;
    }
    this.history.record(before);
    this.set({ ...extra, historyVersion: this.state.historyVersion + 1 });
  }

  /** Live update without a history entry (during drags and typing). */
  updateElements(elements: readonly SceneElement[]) {
    this.set({ elements: finalizeScene(elements) });
  }

  undo() {
    const prev = this.history.undo(this.snapshot());
    if (!prev) return false;
    this.set({
      elements: prev.elements,
      files: prev.files,
      editingTextId: null,
      historyVersion: this.state.historyVersion + 1,
    });
    return true;
  }

  redo() {
    const next = this.history.redo(this.snapshot());
    if (!next) return false;
    this.set({
      elements: next.elements,
      files: next.files,
      editingTextId: null,
      historyVersion: this.state.historyVersion + 1,
    });
    return true;
  }

  toast(message: string, tone: Toast["tone"] = "info", ms = 4200, action?: Toast["action"]) {
    const id = ++this.toastId;
    this.set({ toasts: [...this.state.toasts, { id, message, tone, action }] });
    if (typeof window !== "undefined") {
      window.setTimeout(() => this.dismissToast(id), ms);
    }
    return id;
  }

  dismissToast(id: number) {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  boardSettings() {
    return {
      theme: this.state.theme,
      viewBackgroundColor: this.state.viewBackgroundColor,
      gridEnabled: this.state.gridEnabled,
    };
  }
}
