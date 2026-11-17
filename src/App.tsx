import { isColor } from "./shared/limits";
import { finalizeScene } from "./scene/scene";
import { PAPER } from "./scene/constants";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { STORAGE_KEY, getStorage, loadFromStorage, type StorageLike } from "./io/autosave";
import { httpApi } from "./sync/api";
import type { SessionBoot } from "./sync/session";
import { LOST_NOTICE, SyncClient, applyOpsToScene } from "./sync/client";
import { inlineFiles, usedFileIds } from "./sync/files";
import { importIntoSession } from "./sync/importBoard";
import { PendingMirror } from "./sync/mirror";
import { boardLabel, rememberBoard } from "./sync/recent";
import type { FileMap } from "./scene/types";
import { readPasteEvent } from "./io/clipboard";
import { downloadBlob, timestampName } from "./io/export";
import { FormatError, parseBoard, serializeBoard, type ChalanaFile } from "./io/serialize";
import { getCommonBounds } from "./scene/geometry";
import { fitBounds } from "./scene/viewport";
import {
  copySelectionAs,
  copyStyles,
  copyToEvent,
  deletePoint,
  deleteSelected,
  duplicateSelected,
  fitToContent,
  flipSelected,
  groupSelected,
  lockSelected,
  pasteStyles,
  reorderSelected,
  ungroupSelected,
  pasteContent,
  insertImageBlob,
  redo,
  resetZoom,
  selectAll,
  setTool,
  undo,
  zoomBy,
  blockedByViewMode,
} from "./store/actions";
import { DEFAULT_PREFERENCES, Store, initialState, type Preferences } from "./store/store";
import { EmbedError, extractFromPng, extractFromSvg } from "./io/embed";
import { ModeBanners, SearchBar, StatsPanel } from "./ui/ViewPanels";
import { Controller } from "./tools/controller";
import { Canvas } from "./ui/Canvas";
import {
  AppContext,
  useAppState,
  useServices,
  type AppServices,
  type SessionServices,
} from "./ui/context";
import { Dialogs } from "./ui/Dialogs";
import { PropertiesPanel } from "./ui/PropertiesPanel";
import { TextEditor } from "./ui/TextEditor";
import { ToolRail } from "./ui/ToolRail";
import { ZoomStrip } from "./ui/ZoomStrip";
import { TOOLS } from "./ui/shortcuts";
import { Minimap } from "./ui/Minimap";
import { WebCards } from "./ui/WebCards";
import type { Theme } from "./scene/types";

const THEME_KEY = "chalanamaya.theme";
export const PREFS_KEY = "chalanamaya.prefs";

const readPrefs = (storage: StorageLike | null): Preferences => {
  try {
    const raw = JSON.parse(storage?.getItem(PREFS_KEY) ?? "null") as Partial<Preferences> | null;
    if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFERENCES };
    return {
      penMode: typeof raw.penMode === "boolean" ? raw.penMode : DEFAULT_PREFERENCES.penMode,
      inputPreference:
        raw.inputPreference === "mouse" || raw.inputPreference === "trackpad"
          ? raw.inputPreference
          : DEFAULT_PREFERENCES.inputPreference,
      snapping: typeof raw.snapping === "boolean" ? raw.snapping : DEFAULT_PREFERENCES.snapping,
      pencilPressure:
        typeof raw.pencilPressure === "boolean"
          ? raw.pencilPressure
          : DEFAULT_PREFERENCES.pencilPressure,
      minimap: typeof raw.minimap === "boolean" ? raw.minimap : DEFAULT_PREFERENCES.minimap,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
};

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return (
    el.isContentEditable ||
    el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" &&
      (el as HTMLInputElement).type !== "checkbox" &&
      (el as HTMLInputElement).type !== "radio")
  );
};

/** Set once the old browser board was imported or dismissed (it is kept until removed). */
export const LEGACY_DONE_KEY = "chalanamaya.board.v1.handled";

const legacyBoard = (storage: StorageLike | null) => {
  try {
    if (storage?.getItem(LEGACY_DONE_KEY)) return null;
    const saved = loadFromStorage(storage);
    return saved && saved.elements.length ? saved : null;
  } catch {
    return null;
  }
};

/** The session's files as the board's file map (board-relative URLs). */
const sessionFiles = (boot: SessionBoot): FileMap =>
  Object.fromEntries(
    boot.snapshot.files.map((f) => [f.id, { id: f.id, mimeType: f.mime, dataURL: f.url }]),
  );

const createStore = (boot: SessionBoot) => {
  const storage = getStorage();
  const state = initialState();
  let savedTheme: string | null = null;
  try {
    savedTheme = storage?.getItem(THEME_KEY) ?? null;
  } catch {
    savedTheme = null;
  }
  const snap = boot.snapshot;
  // the server snapshot first, then batches the server could not take while
  // the board opened, then ops that never left before the last reload
  const overlay = [...boot.pending.flatMap((b) => b.ops), ...boot.unsent];
  const keyed = applyOpsToScene(snap.elements, overlay);
  state.elements = finalizeScene(keyed.map((e) => e.el));
  state.files = sessionFiles(boot);
  const bg = snap.settings.viewBackgroundColor;
  state.viewBackgroundColor = bg && isColor(bg) ? bg : PAPER.light;
  state.gridEnabled = snap.settings.gridEnabled ?? false;
  let title = snap.title;
  for (const op of overlay)
    if (op.t === "settings") {
      if (op.settings.viewBackgroundColor)
        state.viewBackgroundColor = op.settings.viewBackgroundColor;
      if (op.settings.gridEnabled !== undefined) state.gridEnabled = op.settings.gridEnabled;
      if (op.settings.title !== undefined) title = op.settings.title;
    }
  state.session = { id: boot.id, title };
  state.prefs = readPrefs(storage);
  if (savedTheme === "light" || savedTheme === "dark") state.theme = savedTheme;
  const legacy = legacyBoard(storage);
  state.legacyBoard = legacy ? { count: legacy.elements.length } : null;
  const store = new Store(state);
  store.sessionMode = true;
  store.uploadFile = async (blob) => {
    const up = await httpApi.upload(boot.id, blob);
    return { id: up.file_id, url: up.url, mime: up.mime };
  };
  return store;
};

/** The save state of the board: Saved, Saving or Not saved. */
const SaveStatusChip = () => {
  const status = useAppState((s) => s.saveStatus);
  const label =
    status === "saved"
      ? "Saved"
      : status === "saving"
        ? "Saving…"
        : status === "offline"
          ? "Not saved — retrying"
          : status === "gone"
            ? "Not saved — board deleted"
            : "Not saved — server storage full";
  return (
    <div
      className={`save-status save-${status}`}
      data-testid="save-status"
      data-state={status}
      role="status"
      title={
        status === "offline"
          ? "The server could not be reached. Changes are kept in this browser and sent when it is back."
          : undefined
      }
    >
      {label}
    </div>
  );
};

const LegacyBanner = () => {
  const { session } = useServices();
  const legacy = useAppState((s) => s.legacyBoard);
  const viewMode = useAppState((s) => s.viewMode);
  if (!legacy || !session || viewMode) return null;
  return (
    <div className="legacy-banner" role="region" aria-label="Old board" data-testid="legacy-banner">
      <span>
        This browser still has a board from an earlier version ({legacy.count} item
        {legacy.count === 1 ? "" : "s"}).
      </span>
      <button
        type="button"
        className="btn btn-primary"
        data-testid="legacy-import"
        onClick={session.importLegacy}
      >
        Import it into this board
      </button>
      <button
        type="button"
        className="btn"
        data-testid="legacy-dismiss"
        title="Hides this notice for good. The old board stays in the menu under “Import the board saved in this browser”."
        onClick={session.dismissLegacy}
      >
        Hide this
      </button>
      <button
        type="button"
        className="btn"
        data-testid="legacy-remove"
        onClick={session.removeLegacy}
      >
        Remove the old copy
      </button>
    </div>
  );
};

const Toasts = () => {
  const { store } = useServices();
  const toasts = useAppState((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} data-testid="toast">
          <span>{t.message}</span>
          {t.action ? (
            <button
              type="button"
              className="toast-action"
              data-testid={t.action.testId}
              onClick={() => {
                store.dismissToast(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" aria-label="Dismiss" onClick={() => store.dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
};

const StorageWarning = () => {
  const { store, saveFile } = useServices();
  const warning = useAppState((s) => s.storageWarning);
  if (!warning) return null;
  return (
    <div className="storage-warning" role="alert" data-testid="storage-warning">
      <strong>Not protected.</strong> {warning} Save a .chalana file to keep your work.
      <button type="button" className="btn" onClick={saveFile}>
        Save file
      </button>
      <button type="button" className="btn" onClick={() => store.set({ storageWarning: null })}>
        Dismiss
      </button>
    </div>
  );
};

const PathHint = () => {
  const tool = useAppState((s) => s.tool);
  const editing = useAppState((s) => s.editingTextId);
  const empty = useAppState((s) => s.elements.length === 0);
  let text: string | null = null;
  if (editing) text = "Typing — Escape or click outside to finish";
  else if (tool === "line")
    text =
      "Click to add points · double-click, Enter or Escape to finish · click the first point to close";
  else if (tool === "text") text = "Click anywhere to start typing";
  else if (tool === "hand") text = "Drag to move around the board";
  else if (tool === "freedraw") text = "Drag to sketch · turn on Keep drawing for several strokes";
  else if (tool === "eraser") text = "Drag across items to rub them out · release to erase";
  else if (tool === "lasso") text = "Draw a loop around the items to pick";
  else if (tool === "note") text = "Click to place a sticky note and start typing";
  else if (tool === "frame") text = "Drag to draw a page frame · items fully inside belong to it";
  else if (tool === "laser") text = "Drag to point things out · the Spotlight trail fades away";
  else if (tool === "tidy")
    text = "Sketch a box, diamond or oval in one stroke · Shape tidy turns it into a shape";
  else if (tool === "pour") text = "Click inside a closed shape to pour the current fill into it";
  else if (tool === "embed") text = "Click where the web card should go, then paste its link";
  else if (empty && tool === "pick")
    text = "Pick a tool on the left to start drawing · press ? for shortcuts";
  if (!text) return null;
  return (
    <p className="canvas-hint" data-testid="canvas-hint">
      {text}
    </p>
  );
};

export const App = ({ boot }: { boot: SessionBoot }) => {
  const [store] = useState(() => createStore(boot));
  const [sync] = useState(
    () =>
      new SyncClient(
        boot.id,
        httpApi,
        {
          scene: () => {
            const s = store.get();
            return {
              elements: s.elements,
              settings: {
                viewBackgroundColor: s.viewBackgroundColor,
                gridEnabled: s.gridEnabled,
                title: s.session?.title ?? "",
              },
            };
          },
          replaceElements: (elements) => store.set({ elements }),
          status: (saveStatus) => store.set({ saveStatus }),
          protection: (storageWarning) => store.set({ storageWarning }),
          notice: (message) => store.toast(message, "error", 8000),
          takeLayerMoves: () => {
            const ids = [...store.layerMoves];
            store.layerMoves.clear();
            return ids;
          },
        },
        new PendingMirror(getStorage(), boot.id),
        {
          ...boot.snapshot,
          settings: {
            viewBackgroundColor:
              boot.snapshot.settings.viewBackgroundColor ?? store.get().viewBackgroundColor,
            gridEnabled: boot.snapshot.settings.gridEnabled ?? false,
          },
        },
        boot.pending,
      ),
  );
  const controller = useMemo(() => new Controller(store), [store]);
  const fileInput = useRef<HTMLInputElement>(null);
  const pictureInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useSyncTheme(store);
  const zen = useSyncExternalStore(store.subscribe, () => store.get().zenMode);
  const viewMode = useSyncExternalStore(store.subscribe, () => store.get().viewMode);
  const minimap = useSyncExternalStore(store.subscribe, () => store.get().prefs.minimap);
  const itemCount = useSyncExternalStore(store.subscribe, () => store.get().elements.length);

  const services: AppServices = useMemo(() => {
    const saveFile = () => {
      const s = store.get();
      const doc = rootRef.current?.ownerDocument ?? document;
      // a .chalana file carries its pictures as data URLs
      void inlineFiles(s.files, usedFileIds(s.elements)).then((files) => {
        const text = serializeBoard(s.elements, files, store.boardSettings());
        downloadBlob(new Blob([text], { type: "application/json" }), timestampName("chalana"), doc);
        store.toast("Saved a .chalana file to your downloads.", "success", 2500);
      });
    };
    const openFile = () => {
      if (!blockedByViewMode(store)) fileInput.current?.click();
    };
    const insertPicture = () => {
      if (!blockedByViewMode(store)) pictureInput.current?.click();
    };
    const storage = getStorage();
    const legacyDone = () => {
      try {
        storage?.setItem(LEGACY_DONE_KEY, String(Date.now()));
      } catch {
        // the banner simply shows again next time
      }
      store.set({ legacyBoard: null });
    };
    const removeLegacy = () => {
      try {
        storage?.removeItem?.(STORAGE_KEY);
      } catch {
        // nothing to remove
      }
      legacyDone();
      store.toast("The old browser copy was removed.", "info", 3000);
    };
    const session: SessionServices = {
      newBoard: () => window.location.assign("/"),
      copyLink: () => {
        const url = `${window.location.origin}/s/${boot.id}`;
        void (
          navigator.clipboard?.writeText(url) ?? Promise.reject(new Error("no clipboard"))
        ).then(
          () =>
            store.toast(
              "Board link copied. Anyone with it can change this board.",
              "success",
              3500,
            ),
          () => store.toast(`Copy this link: ${url}`, "info", 9000),
        );
      },
      copyId: () => {
        void (
          navigator.clipboard?.writeText(boot.id) ?? Promise.reject(new Error("no clipboard"))
        ).then(
          () =>
            store.toast(
              "Board id copied. An agent needs only this id, and anyone with it can change this board.",
              "success",
              3500,
            ),
          () => store.toast(`Board id: ${boot.id}`, "info", 9000),
        );
      },
      setTitle: (title) => {
        const s = store.get().session;
        if (s) store.set({ session: { ...s, title } });
      },
      importLegacy: () => {
        const saved = loadFromStorage(storage);
        if (!saved) return legacyDone();
        store.set({ legacyBoard: null });
        void importIntoSession(store, sync, saved, "add").then((r) => {
          if (!r.ok) return;
          legacyDone();
          store.toast(
            `Imported ${r.count} item${r.count === 1 ? "" : "s"} from the old browser board. ${r.summary} The old copy is kept until you remove it.`,
            "success",
            9000,
            { label: "Remove the old copy", testId: "legacy-remove-toast", run: removeLegacy },
          );
        });
      },
      removeLegacy,
      dismissLegacy: legacyDone,
    };
    return { store, controller, saveFile, openFile, insertPicture, session };
  }, [store, controller, sync, boot.id]);

  // save to the session
  useEffect(() => {
    const storage = getStorage();
    const win = rootRef.current?.ownerDocument.defaultView ?? window;
    store.ownerWindow = win;
    let lastPrefs = store.get().prefs;
    const boardKey = (s: ReturnType<typeof store.get>) =>
      [s.viewBackgroundColor, s.gridEnabled, s.session?.title].join("\u0000");
    let lastBoard = boardKey(store.get());
    let lastTitle = store.get().session?.title ?? "";
    rememberBoard(storage, { id: boot.id, title: lastTitle });
    win.document.title = `${boardLabel(lastTitle)} — ChalanaMaya`;
    const unsubPrefs = store.subscribe(() => {
      const s = store.get();
      if (s.prefs !== lastPrefs) {
        lastPrefs = s.prefs;
        try {
          storage?.setItem(PREFS_KEY, JSON.stringify(s.prefs));
        } catch {
          // preferences are optional
        }
      }
      const board = boardKey(s);
      if (board !== lastBoard) {
        lastBoard = board;
        store.onSceneChange?.();
      }
      const title = s.session?.title ?? "";
      if (title !== lastTitle) {
        lastTitle = title;
        rememberBoard(storage, { id: boot.id, title });
        win.document.title = `${boardLabel(title)} — ChalanaMaya`;
      }
    });
    store.onSceneChange = () => sync.schedule();
    store.onCommit = () => sync.flush();
    // ops that never left before the last reload (and batches the server could
    // not take while the board opened) go out now, with back-off
    if (boot.unsent.length || boot.pending.length) sync.schedule();
    if (boot.lost) store.toast(LOST_NOTICE, "error", 9000);
    const onHide = () => sync.pageHide();
    win.addEventListener("pagehide", onHide);
    // test hook: lets e2e specs wait until everything is acknowledged
    (win as unknown as { __chalanaSync?: SyncClient }).__chalanaSync = sync;
    return () => {
      unsubPrefs();
      store.onSceneChange = null;
      store.onCommit = null;
      win.removeEventListener("pagehide", onHide);
    };
  }, [store, sync, boot]);

  // keyboard, clipboard
  useEffect(() => {
    const doc = rootRef.current!.ownerDocument;
    const onKey = (e: KeyboardEvent) => {
      const s = store.get();
      if (s.dialog || isTypingTarget(e.target) || s.editingTextId) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const ro = s.viewMode;
      if (e.altKey && !mod) {
        const code = e.code;
        if (code === "KeyZ") return (e.preventDefault(), store.set({ zenMode: !s.zenMode }));
        if (code === "KeyM")
          return (
            e.preventDefault(),
            store.set({ prefs: { ...s.prefs, minimap: !s.prefs.minimap } })
          );
        if (code === "KeyR") {
          e.preventDefault();
          return store.set({
            viewMode: !ro,
            selectedIds: new Set(),
            tool: "pick",
            editingPointsId: null,
            croppingId: null,
          });
        }
        if (code === "Slash") return (e.preventDefault(), store.set({ statsOpen: !s.statsOpen }));
        if (code === "KeyC" && e.shiftKey)
          return (e.preventDefault(), void copySelectionAs(store, "png"));
      }
      if (e.key === " " && !mod) {
        if (!controller.spaceHeld) {
          controller.spaceHeld = true;
          controller.cursor = "grab";
          controller.onOverlay();
        }
        e.preventDefault();
        return;
      }
      if (mod) {
        const handled = (() => {
          if (key === "f") return (store.set({ searchOpen: true }), true);
          if (key === "'" || e.code === "Quote")
            return (store.set({ gridEnabled: !s.gridEnabled }), true);
          if (key === "=" || key === "+") return (zoomBy(store, 1.2), true);
          if (key === "-") return (zoomBy(store, 1 / 1.2), true);
          if (key === "0") return (resetZoom(store), true);
          if (key === "s") return (services.saveFile(), true);
          if (key === "e" && e.shiftKey) return (store.set({ dialog: { kind: "export" } }), true);
          if (key === "a" && !ro) return (selectAll(store), true);
          if (ro) return key === "z" || key === "y" || key === "d" || key === "o" || key === "g";
          if (e.altKey && e.code === "KeyC") return (copyStyles(store), true);
          if (e.altKey && e.code === "KeyV") return (pasteStyles(store), true);
          if (key === "g" && e.shiftKey) return (ungroupSelected(store), true);
          if (key === "g") return (groupSelected(store), true);
          if (key === "l" && e.shiftKey) return (lockSelected(store), true);
          if (key === "k") {
            const sel = s.elements.filter((x) => s.selectedIds.has(x.id));
            if (sel.length === 1) store.set({ dialog: { kind: "link", elementId: sel[0].id } });
            else store.toast("Select one item to add a link.");
            return true;
          }
          if (e.code === "BracketLeft")
            return (reorderSelected(store, e.shiftKey ? "back" : "backward"), true);
          if (e.code === "BracketRight")
            return (reorderSelected(store, e.shiftKey ? "front" : "forward"), true);
          if (key === "z" && !e.shiftKey) return (undo(store), true);
          if ((key === "z" && e.shiftKey) || key === "y") return (redo(store), true);
          if (key === "a") return (selectAll(store), true);
          if (key === "d") return (duplicateSelected(store), true);
          if (key === "s") return (services.saveFile(), true);
          if (key === "o") return (services.openFile(), true);
          if (key === "e" && e.shiftKey) return (store.set({ dialog: { kind: "export" } }), true);
          if (key === "=" || key === "+") return (zoomBy(store, 1.2), true);
          if (key === "-") return (zoomBy(store, 1 / 1.2), true);
          if (key === "0") return (resetZoom(store), true);
          return false;
        })();
        if (handled) e.preventDefault();
        return;
      }
      if (e.altKey) return;
      if (e.key === "Escape") {
        if (s.tool === "eyedropper") setTool(store, s.toolBeforeEyedropper);
        else if (controller.isBusy()) controller.cancel();
        else if (s.activeEmbedId) store.set({ activeEmbedId: null });
        else if (s.searchOpen) store.set({ searchOpen: false, searchHighlight: null });
        else if (s.editingPointsId || s.croppingId)
          store.set({ editingPointsId: null, croppingId: null, editingPointIndex: null });
        else if (s.menuOpen) store.set({ menuOpen: false });
        else if (s.selectedIds.size) store.set({ selectedIds: new Set() });
        else if (s.tool !== "pick") setTool(store, "pick");
        return;
      }
      if (ro) {
        if (e.key === "?") store.set({ dialog: { kind: "help" } });
        else if (e.shiftKey && e.code === "Digit1") fitToContent(store, false);
        else if (key === "h" || key === "v") setTool(store, key === "h" ? "hand" : "pick");
        else if (key === "x") setTool(store, "laser");
        return;
      }
      if (e.key === "Enter") {
        if (controller.isDrawingPath) {
          controller.finishPath(false);
          e.preventDefault();
          return;
        }
        if (s.selectedIds.size === 1) {
          const el = s.elements.find((x) => s.selectedIds.has(x.id));
          if (el?.type === "embed" && controller.activateWebCard(el)) {
            e.preventDefault();
            return;
          }
          if (
            el &&
            (el.type === "text" ||
              el.type === "rectangle" ||
              el.type === "diamond" ||
              el.type === "ellipse" ||
              el.type === "note" ||
              el.type === "arrow")
          ) {
            e.preventDefault();
            if (el.type === "text") controller.startTextEdit(el.id);
            else controller.editContainerText(el);
          }
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (!deletePoint(store)) deleteSelected(store);
        e.preventDefault();
        return;
      }
      if (e.key === "?") {
        store.set({ dialog: { kind: "help" } });
        e.preventDefault();
        return;
      }
      if (e.shiftKey && (e.code === "Digit1" || e.key === "!")) {
        fitToContent(store, false);
        e.preventDefault();
        return;
      }
      if (e.shiftKey && (e.code === "Digit2" || e.key === "@")) {
        fitToContent(store, true);
        e.preventDefault();
        return;
      }
      if (e.shiftKey && e.code === "KeyH")
        return (e.preventDefault(), void flipSelected(store, "horizontal"));
      if (e.shiftKey && e.code === "KeyV")
        return (e.preventDefault(), void flipSelected(store, "vertical"));
      if (e.shiftKey) return;
      if (key === "k" && !controller.isBusy()) {
        store.set({ toolLocked: !s.toolLocked });
        store.toast(s.toolLocked ? "Keep drawing is off." : "Keep drawing is on.", "info", 1500);
        e.preventDefault();
        return;
      }
      const tool = TOOLS.find((t) => t.key.toLowerCase() === key || t.digit === e.key);
      if (tool && !controller.isBusy()) {
        setTool(store, tool.id);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " && controller.spaceHeld) {
        controller.spaceHeld = false;
        controller.cursor = "default";
        controller.onOverlay();
      }
    };
    const onBlur = () => {
      controller.spaceHeld = false;
      // a drag can't finish once the window loses focus; multi-click paths stay open
      if (controller.isBusy() && !controller.isDrawingPath) controller.cancel();
    };
    const editable = () => {
      const s = store.get();
      return !s.dialog && !s.editingTextId && !isTypingTarget(doc.activeElement);
    };
    const onCopy = (e: ClipboardEvent) => {
      if (!editable() || !store.get().selectedIds.size) return;
      e.preventDefault();
      copyToEvent(store, e.clipboardData, false);
    };
    const onCut = (e: ClipboardEvent) => {
      if (!editable() || !store.get().selectedIds.size || store.get().viewMode) return;
      e.preventDefault();
      copyToEvent(store, e.clipboardData, true);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!editable() || store.get().viewMode) return;
      e.preventDefault();
      void pasteContent(store, readPasteEvent(e.clipboardData));
    };
    const win = doc.defaultView!;
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("keyup", onKeyUp);
    win.addEventListener("blur", onBlur);
    doc.addEventListener("copy", onCopy);
    doc.addEventListener("cut", onCut);
    doc.addEventListener("paste", onPaste);
    return () => {
      doc.removeEventListener("keydown", onKey);
      doc.removeEventListener("keyup", onKeyUp);
      win.removeEventListener("blur", onBlur);
      doc.removeEventListener("copy", onCopy);
      doc.removeEventListener("cut", onCut);
      doc.removeEventListener("paste", onPaste);
    };
  }, [store, controller, services]);

  const applyOpened = (file: ChalanaFile) => {
    if (blockedByViewMode(store)) return;
    const view = store.viewSize;
    // lenient file edge: canonicalise, upload pictures, then one atomic import (plan §4.1)
    void importIntoSession(store, sync, file, "replace").then((r) => {
      if (!r.ok) return;
      const b = getCommonBounds(store.get().elements);
      store.set({
        theme: file.settings.theme,
        viewport: (b && fitBounds(b, view.width, view.height)) || {
          scrollX: 0,
          scrollY: 0,
          zoom: 1,
        },
      });
      const extra = r.failedPictures
        ? ` ${r.failedPictures} picture${r.failedPictures === 1 ? "" : "s"} could not be uploaded and were left out.`
        : "";
      store.toast(
        r.summary ? `Board opened. ${r.summary}${extra}` : `Board opened.${extra}`,
        "success",
        r.summary || extra ? 5000 : 2500,
      );
    });
  };

  const onFileChosen = async (input: HTMLInputElement) => {
    const f = input.files?.[0];
    input.value = "";
    if (!f || blockedByViewMode(store)) return;
    let parsed: ChalanaFile;
    try {
      const name = f.name.toLowerCase();
      let text: string | null;
      if (f.type === "image/png" || name.endsWith(".png")) {
        text = extractFromPng(new Uint8Array(await f.arrayBuffer()));
        if (text === null)
          throw new EmbedError(
            "This picture has no editable board data. You can still paste it onto the board as an image.",
          );
      } else if (f.type === "image/svg+xml" || name.endsWith(".svg")) {
        text = extractFromSvg(await f.text());
        if (text === null) throw new EmbedError("This SVG has no editable board data.");
      } else text = await f.text();
      parsed = parseBoard(text);
    } catch (err) {
      const msg =
        err instanceof FormatError || err instanceof EmbedError
          ? err.message
          : "The file could not be read.";
      store.toast(`Couldn't open “${f.name}”: ${msg} Your board is unchanged.`, "error", 7000);
      return;
    }
    if (store.get().elements.length) {
      store.set({
        dialog: { kind: "confirmOpen", fileName: f.name, apply: () => applyOpened(parsed) },
      });
    } else applyOpened(parsed);
  };

  return (
    <AppContext.Provider value={services}>
      <div
        className={`app theme-${theme}${viewMode ? " is-view-mode" : ""}${!zen && minimap ? " has-minimap" : ""}`}
        data-theme={theme}
        ref={rootRef}
        data-testid="app"
        data-items={itemCount}
      >
        <Canvas />
        <WebCards />
        <TextEditor />
        <ToolRail />
        {zen ? null : <PropertiesPanel />}
        {zen ? null : <ZoomStrip />}
        {zen ? null : <StatsPanel />}
        {zen || !minimap ? null : <Minimap />}
        <SearchBar />
        <ModeBanners />
        <PathHint />
        <StorageWarning />
        {zen ? null : <SaveStatusChip />}
        <LegacyBanner />
        <Toasts />
        <Dialogs />
        <input
          ref={fileInput}
          type="file"
          accept=".chalana,application/json,.png,image/png,.svg,image/svg+xml"
          hidden
          data-testid="file-input"
          onChange={(e) => void onFileChosen(e.currentTarget)}
        />
        <input
          ref={pictureInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
          hidden
          data-testid="picture-input"
          onChange={(e) => {
            const input = e.currentTarget;
            const f = input.files?.[0];
            input.value = "";
            if (!f) return;
            if (!f.type.startsWith("image/")) {
              store.toast(
                `“${f.name}” isn't a supported picture (PNG, JPEG, GIF, WebP or SVG). The board was not changed.`,
                "error",
                6000,
              );
              return;
            }
            void insertImageBlob(store, f);
          }}
        />
      </div>
    </AppContext.Provider>
  );
};

/** Mirrors the theme to <html> (for scrollbars/colour-scheme) and remembers it. */
function useSyncTheme(store: Store): Theme {
  const theme = useSyncExternalStoreTheme(store);
  // the theme is personal: it stays in this browser and is not part of the session
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    try {
      getStorage()?.setItem(THEME_KEY, theme);
    } catch {
      // theme preference is optional
    }
  }, [theme]);
  return theme;
}

const useSyncExternalStoreTheme = (store: Store) =>
  useSyncExternalStore(store.subscribe, () => store.get().theme);
