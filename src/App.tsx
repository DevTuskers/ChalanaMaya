import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  STORAGE_KEY,
  getStorage,
  loadFromStorage,
  saveToStorage,
  type StorageLike,
} from "./io/autosave";
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
  redo,
  resetZoom,
  selectAll,
  setTool,
  undo,
  zoomBy,
} from "./store/actions";
import { DEFAULT_PREFERENCES, Store, initialState, type Preferences } from "./store/store";
import { EmbedError, extractFromPng, extractFromSvg } from "./io/embed";
import { ModeBanners, SearchBar, StatsPanel } from "./ui/ViewPanels";
import { Controller } from "./tools/controller";
import { Canvas } from "./ui/Canvas";
import { AppContext, useAppState, useServices, type AppServices } from "./ui/context";
import { Dialogs } from "./ui/Dialogs";
import { PropertiesPanel } from "./ui/PropertiesPanel";
import { TextEditor } from "./ui/TextEditor";
import { ToolRail } from "./ui/ToolRail";
import { ZoomStrip } from "./ui/ZoomStrip";
import { TOOLS } from "./ui/shortcuts";
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

const createStore = () => {
  const storage = getStorage();
  const state = initialState();
  let savedTheme: string | null = null;
  try {
    savedTheme = storage?.getItem(THEME_KEY) ?? null;
  } catch {
    savedTheme = null;
  }
  const saved = loadFromStorage(storage);
  if (saved) {
    state.elements = saved.elements;
    state.files = saved.files;
    state.theme = saved.settings.theme;
    state.viewBackgroundColor = saved.settings.viewBackgroundColor;
    state.gridEnabled = saved.settings.gridEnabled;
  }
  state.prefs = readPrefs(storage);
  if (savedTheme === "light" || savedTheme === "dark") state.theme = savedTheme;
  const store = new Store(state);
  let unreadable = false;
  try {
    unreadable = !saved && !!storage?.getItem(STORAGE_KEY);
  } catch {
    unreadable = false;
  }
  if (unreadable) {
    store.toast(
      "The board saved in this browser could not be read, so a new board was started. A copy of the old data was kept.",
      "error",
      9000,
    );
  }
  return store;
};

const Toasts = () => {
  const { store } = useServices();
  const toasts = useAppState((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} data-testid="toast">
          <span>{t.message}</span>
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
      <strong>Not saved in this browser.</strong> {warning} Save a .chalana file to keep your work.
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
  else if (empty && tool === "pick")
    text = "Pick a tool on the left to start drawing · press ? for shortcuts";
  if (!text) return null;
  return (
    <p className="canvas-hint" data-testid="canvas-hint">
      {text}
    </p>
  );
};

export const App = () => {
  const store = useMemo(createStore, []);
  const controller = useMemo(() => new Controller(store), [store]);
  const fileInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useSyncTheme(store);
  const zen = useSyncExternalStore(store.subscribe, () => store.get().zenMode);

  const services: AppServices = useMemo(() => {
    const saveFile = () => {
      const s = store.get();
      const text = serializeBoard(s.elements, s.files, store.boardSettings());
      const doc = rootRef.current?.ownerDocument ?? document;
      downloadBlob(new Blob([text], { type: "application/json" }), timestampName("chalana"), doc);
      store.toast("Saved a .chalana file to your downloads.", "success", 2500);
    };
    const openFile = () => fileInput.current?.click();
    return { store, controller, saveFile, openFile };
  }, [store, controller]);

  // autosave
  useEffect(() => {
    const storage = getStorage();
    let timer = 0;
    const win = rootRef.current?.ownerDocument.defaultView ?? window;
    const flush = () => {
      timer = 0;
      const s = store.get();
      const err = saveToStorage(storage, s.elements, s.files, store.boardSettings());
      if (err !== s.storageWarning) {
        if (err || s.storageWarning) store.set({ storageWarning: err });
      }
    };
    store.ownerWindow = win;
    let lastPrefs = store.get().prefs;
    let lastBoard = [store.get().viewBackgroundColor, store.get().gridEnabled].join();
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
      const board = [s.viewBackgroundColor, s.gridEnabled].join();
      if (board !== lastBoard) {
        lastBoard = board;
        store.onSceneChange?.();
      }
    });
    store.onSceneChange = () => {
      if (timer) win.clearTimeout(timer);
      timer = win.setTimeout(flush, 250);
    };
    const onHide = () => {
      if (timer) {
        win.clearTimeout(timer);
        flush();
      }
    };
    win.addEventListener("pagehide", onHide);
    win.addEventListener("beforeunload", onHide);
    return () => {
      unsubPrefs();
      store.onSceneChange = null;
      win.removeEventListener("pagehide", onHide);
      win.removeEventListener("beforeunload", onHide);
    };
  }, [store]);

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
    const view = store.viewSize;
    store.history.record(store.snapshot());
    const b = getCommonBounds(file.elements);
    store.set({
      files: file.files,
      elements: file.elements,
      selectedIds: new Set(),
      editingTextId: null,
      theme: file.settings.theme,
      viewBackgroundColor: file.settings.viewBackgroundColor,
      gridEnabled: file.settings.gridEnabled,
      viewport: (b && fitBounds(b, view.width, view.height)) || { scrollX: 0, scrollY: 0, zoom: 1 },
      historyVersion: store.get().historyVersion + 1,
    });
    store.toast("Board opened.", "success", 2500);
  };

  const onFileChosen = async (input: HTMLInputElement) => {
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
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
      <div className={`app theme-${theme}`} data-theme={theme} ref={rootRef} data-testid="app">
        <Canvas />
        <TextEditor />
        <ToolRail />
        {zen ? null : <PropertiesPanel />}
        {zen ? null : <ZoomStrip />}
        {zen ? null : <StatsPanel />}
        <SearchBar />
        <ModeBanners />
        <PathHint />
        <StorageWarning />
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
      </div>
    </AppContext.Provider>
  );
};

/** Mirrors the theme to <html> (for scrollbars/colour-scheme) and remembers it. */
function useSyncTheme(store: Store): Theme {
  const theme = useSyncExternalStoreTheme(store);
  const firstRun = useRef(true);
  useEffect(() => {
    // the theme is part of the saved board settings, so autosave it too
    if (firstRun.current) firstRun.current = false;
    else store.onSceneChange?.();
  }, [store, theme]);
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
