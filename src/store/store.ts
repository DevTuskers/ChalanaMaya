import { DEFAULT_STYLE, PAPER } from "../scene/constants";
import { History, type Snapshot } from "../scene/history";
import type { RemoteChange } from "../scene/rebase";
import { RemoteLog } from "../sync/remoteLog";
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
  | "hand"
  | "laser"
  | "tidy"
  | "pour"
  | "embed";

export type InputPreference = "mouse" | "trackpad";

export interface Preferences {
  penMode: boolean;
  inputPreference: InputPreference;
  snapping: boolean;
  /** Vary Sketch pencil width with stylus pressure (DRAW-09). */
  pencilPressure: boolean;
  /** Show the board overview (VIEW-05). */
  minimap: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  penMode: false,
  inputPreference: "trackpad",
  snapping: true,
  pencilPressure: true,
  minimap: false,
};

/** A Spotlight stroke: board points with the time (ms) each was drawn. Never saved. */
export interface SpotlightStroke {
  points: { x: number; y: number; t: number }[];
}

export type Dialog =
  | { kind: "help" }
  | { kind: "export" }
  | { kind: "svg" }
  | { kind: "link"; elementId: string }
  | { kind: "openLink"; url: string }
  | { kind: "settings" }
  | { kind: "clear" }
  | { kind: "confirmOpen"; fileName: string; apply: () => void }
  | { kind: "webcard"; at: { x: number; y: number } }
  | { kind: "chart"; text: string }
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
  /** Spotlight (laser) trails; temporary and never part of the board. */
  spotlight: SpotlightStroke[];
  /** Web card that currently receives pointer input. */
  activeEmbedId: string | null;
  /** The server session this board belongs to (null in unit tests). */
  session: { id: string; title: string } | null;
  /** Server save state of the session board. */
  saveStatus: "saved" | "saving" | "offline" | "gone" | "full";
  /** false while the live socket is down: changes save over REST, but others' changes do not show */
  liveSync: boolean;
  /** A board saved by an older version in this browser, offered for import. */
  legacyBoard: { count: number } | null;
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
  spotlight: [],
  activeEmbedId: null,
  session: null,
  saveStatus: "saved",
  liveSync: true,
  legacyBoard: null,
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
  /** Called after a history step (commit, undo, redo): the save path writes at once. */
  onCommit: (() => void) | null = null;
  /** CSS-pixel size of the canvas, kept current by the canvas component. */
  viewSize = { width: 1024, height: 768 };
  /** Window hosting the app (set on mount), used for opening links. */
  ownerWindow: Window | null = null;
  /** Last pointer position over the canvas, in screen px. */
  lastPointer: { x: number; y: number } | null = null;
  /**
   * Rule D: in a server-backed session files are add-only, so undo and redo
   * keep the current files instead of restoring an older file map.
   */
  sessionMode = false;
  /** Ids moved in the layer order since the save path last looked (reorder hint). */
  layerMoves = new Set<string>();
  /** Uploads a picture to the session; unset outside a session (data URLs). */
  uploadFile: ((blob: Blob) => Promise<{ id: string; url: string; mime: string }>) | null = null;

  /** Remote changes applied to this board, for lazy rebasing of older snapshots (Rule C). */
  readonly remoteLog = new RemoteLog();
  /** Layer key of an element as the server has it (set by the sync client). */
  keyOf: ((id: string) => string | undefined) | undefined = undefined;
  /** How often a stale scene was caught and rebased in `set` (tests). */
  staleRestores = 0;
  private snapSeq = new WeakMap<readonly SceneElement[], number>();

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
    if (patch.elements !== undefined && patch.elements !== prev.elements) {
      // removal guard: a scene taken before remote changes (a snapshot being
      // restored) gets them replayed, so restoring never drops others' work
      const seq = this.snapSeq.get(patch.elements);
      if (seq !== undefined && seq < this.remoteLog.head) {
        const rebased = this.remoteLog.rebase(patch.elements, seq, this.keyOf);
        if (rebased !== patch.elements) {
          this.staleRestores += 1;
          patch = { ...patch, elements: rebased };
        }
      }
    }
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
    const seq = this.remoteLog.head;
    if (!this.snapSeq.has(this.state.elements)) this.snapSeq.set(this.state.elements, seq);
    return { elements: this.state.elements, files: this.state.files, seq };
  }

  /** The elements of a snapshot with every later remote change applied (Rule C). */
  rebase(snap: Snapshot): readonly SceneElement[] {
    const seq = snap.seq ?? this.snapSeq.get(snap.elements);
    if (seq === undefined || seq >= this.remoteLog.head) return snap.elements;
    return this.remoteLog.rebase(snap.elements, seq, this.keyOf);
  }

  /**
   * Rule B: a remote change. `elements` is the scene with the change already
   * applied (busy ids skipped); `change` is what the server sent, logged so
   * snapshots taken earlier are rebased when restored. No history step and no
   * local-change callback beyond the save path's diff (which finds nothing
   * new except Rule F repairs).
   */
  applyRemote(
    elements: readonly SceneElement[],
    change: RemoteChange,
    patch: Partial<AppState> = {},
  ) {
    if (change.upserts.length || change.deletes.length) this.remoteLog.append(change);
    const editing = this.state.editingTextId;
    const extra: Partial<AppState> = {};
    if (editing && change.deletes.includes(editing) && !elements.some((e) => e.id === editing))
      extra.editingTextId = null;
    this.set({ ...patch, ...extra, elements });
  }

  /** Records the current scene in history, then applies new elements. */
  commit(
    elements: readonly SceneElement[],
    extra: Partial<AppState> = {},
    /** Ids moved in the layer order by this step (a reorder hint, Rule E). */
    moves?: ReadonlySet<string>,
  ) {
    if (moves?.size) {
      for (const id of moves) this.layerMoves.add(id);
      this.history.record({ ...this.snapshot(), moves: [...moves] });
    } else this.history.record(this.snapshot());
    this.set({
      ...extra,
      elements: finalizeScene(elements),
      historyVersion: this.state.historyVersion + 1,
    });
    this.onCommit?.();
  }

  /** Records a snapshot taken earlier (e.g. at the start of a drag). */
  commitFrom(before: Snapshot, extra: Partial<AppState> = {}) {
    if (before.elements === this.state.elements && before.files === this.state.files) {
      if (Object.keys(extra).length) this.set(extra);
      return;
    }
    this.history.record(before);
    this.set({ ...extra, historyVersion: this.state.historyVersion + 1 });
    this.onCommit?.();
  }

  /** Live update without a history entry (during drags and typing). */
  updateElements(elements: readonly SceneElement[]) {
    this.set({ elements: finalizeScene(elements) });
  }

  undo() {
    const prev = this.history.undo(this.snapshot());
    if (!prev) return false;
    for (const id of prev.moves ?? []) this.layerMoves.add(id);
    this.set({
      elements: this.rebase(prev),
      files: this.sessionMode ? this.state.files : prev.files,
      editingTextId: null,
      historyVersion: this.state.historyVersion + 1,
    });
    this.onCommit?.();
    return true;
  }

  redo() {
    const next = this.history.redo(this.snapshot());
    if (!next) return false;
    for (const id of next.moves ?? []) this.layerMoves.add(id);
    this.set({
      elements: this.rebase(next),
      files: this.sessionMode ? this.state.files : next.files,
      editingTextId: null,
      historyVersion: this.state.historyVersion + 1,
    });
    this.onCommit?.();
    return true;
  }

  toast(message: string, tone: Toast["tone"] = "info", ms = 4200, action?: Toast["action"]) {
    const id = ++this.toastId;
    // a repeated message replaces the earlier copy instead of stacking
    const rest = this.state.toasts.filter((t) => t.message !== message);
    this.set({ toasts: [...rest, { id, message, tone, action }] });
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
