import { createFrame, createImage, createText, isLinear } from "../scene/elements";
import { getCommonBounds } from "../scene/geometry";
import {
  cloneElements,
  deleteElements,
  duplicateElements,
  getBoundText,
  selectAll as selectAllIds,
  withBoundTexts,
} from "../scene/scene";
import { layoutText } from "../scene/text";
import type { ItemStyle, SceneElement, ShapeType } from "../scene/types";
import {
  alignElements,
  assignFrames,
  distributeElements,
  extractStyle,
  flipElements,
  groupElements,
  internalTarget,
  normalizeLink,
  pasteStyle,
  removePoint,
  reorder,
  setLocked,
  switchType,
  ungroupElements,
  type Align,
  type ZOrder,
} from "../scene/arrange";
import { resetCrop } from "../scene/crop";
import { copyAs, selectionTargets, type CopyKind } from "../io/flows";
import { clampZoom, fitBounds, screenToScene, zoomAt } from "../scene/viewport";
import {
  blobToDataURL,
  imageSize,
  readClipboardApi,
  writeClipboardText,
  type PasteContent,
} from "../io/clipboard";
import { serializeClipboard } from "../io/serialize";
import type { AppState, Store, ToolId } from "./store";

export const viewCenter = (store: Store) => ({
  x: store.viewSize.width / 2,
  y: store.viewSize.height / 2,
});

/** True (with a notice) when look-only mode is on; board-changing actions stop early. */
export const blockedByViewMode = (store: Store) => {
  if (!store.get().viewMode) return false;
  store.toast("Look-only mode is on. Leave it to change the board.");
  return true;
};

export const setTool = (store: Store, tool: ToolId) => {
  const s = store.get();
  if (s.viewMode && tool !== "hand" && tool !== "pick") {
    store.toast("Look-only mode is on. Leave it to draw or edit.");
    return;
  }
  const patch: Parameters<Store["set"]>[0] = {
    tool,
    menuOpen: false,
    editingPointsId: null,
    croppingId: null,
  };
  if (tool === "eyedropper") {
    if (s.tool !== "eyedropper") patch.toolBeforeEyedropper = s.tool;
  } else if (tool !== "pick") patch.selectedIds = new Set();
  store.set(patch);
};

export const undo = (store: Store) => {
  if (blockedByViewMode(store)) return;
  if (!store.undo()) store.toast("Nothing to undo.");
};

export const redo = (store: Store) => {
  if (blockedByViewMode(store)) return;
  if (!store.redo()) store.toast("Nothing to redo.");
};

export const selectAll = (store: Store) => {
  store.set({ selectedIds: new Set(selectAllIds(store.get().elements)), tool: "pick" });
};

export const deleteSelected = (store: Store) => {
  if (store.get().viewMode) return;
  const { elements, selectedIds } = store.get();
  if (!selectedIds.size) return;
  store.commit(deleteElements(elements, selectedIds), { selectedIds: new Set() });
};

export const duplicateSelected = (store: Store) => {
  if (blockedByViewMode(store)) return;
  const { elements, selectedIds } = store.get();
  if (!selectedIds.size) return;
  const res = duplicateElements(elements, selectedIds);
  store.commit(res.elements, { selectedIds: new Set(res.newIds) });
};

/** Changes the current style and applies it to the matching selected elements. */
export const applyStyle = (store: Store, patch: Partial<ItemStyle>) => {
  if (store.get().viewMode) return;
  const { elements, currentStyle, editingTextId } = store.get();
  const selectedIds =
    store.get().selectedIds.size || !editingTextId
      ? store.get().selectedIds
      : new Set([editingTextId]);
  const nextStyle = { ...currentStyle, ...patch };
  if (!selectedIds.size) {
    store.set({ currentStyle: nextStyle });
    return;
  }
  const styled = pasteStyle(elements, selectedIds, patch);
  const next = styled
    ? styled.map((el) =>
        el.type === "text" && !el.containerId && el !== elements.find((e) => e.id === el.id)
          ? layoutText(el)
          : el,
      )
    : elements;
  const changed = styled !== null;
  if (!changed) {
    store.set({ currentStyle: nextStyle });
  } else if (editingTextId) {
    // The text edit session records one history entry (from its start snapshot)
    // when editing ends, so style changes made while typing must not add their own.
    store.updateElements(next);
    store.set({ currentStyle: nextStyle });
  } else {
    store.commit(next, { currentStyle: nextStyle });
  }
};

export const zoomBy = (store: Store, factor: number, at = viewCenter(store)) => {
  const v = store.get().viewport;
  store.set({ viewport: zoomAt(v, clampZoom(v.zoom * factor), at) });
};

export const resetZoom = (store: Store) => {
  store.set({ viewport: zoomAt(store.get().viewport, 1, viewCenter(store)) });
};

export const fitToContent = (store: Store, selectionOnly: boolean) => {
  const { elements, selectedIds } = store.get();
  if (selectionOnly && !selectedIds.size) {
    store.toast("Select something first to zoom to it.");
    return;
  }
  const targets = selectionOnly ? elements.filter((e) => selectedIds.has(e.id)) : elements;
  const v = fitBounds(getCommonBounds(targets), store.viewSize.width, store.viewSize.height);
  if (!v) {
    store.toast("The board is empty, so there is nothing to fit.");
    return;
  }
  store.set({ viewport: v });
};

// ---- clipboard ----

const copyPayload = (store: Store) => {
  const { elements, files, selectedIds } = store.get();
  const ids = withBoundTexts(elements, selectedIds);
  return serializeClipboard(
    elements.filter((e) => ids.has(e.id)),
    files,
  );
};

/** For keyboard copy/cut: fills the native clipboard event synchronously. */
export const copyToEvent = (store: Store, data: DataTransfer | null, cut: boolean) => {
  if (!store.get().selectedIds.size) return false;
  if (!data) {
    store.toast("The clipboard is not available here, so nothing was copied.", "error");
    return false;
  }
  try {
    data.setData("text/plain", copyPayload(store));
  } catch {
    store.toast("The clipboard rejected the copy, so nothing was cut.", "error");
    return false;
  }
  if (cut) deleteSelected(store);
  return true;
};

/** For menu buttons: uses the async clipboard API. Cut only removes after a successful copy. */
export const copyWithApi = async (store: Store, cut: boolean) => {
  if (!store.get().selectedIds.size) {
    store.toast("Select something to copy first.");
    return false;
  }
  const ok = await writeClipboardText(copyPayload(store));
  if (!ok) {
    store.toast(
      cut
        ? "Couldn't reach the clipboard, so nothing was cut. Try Ctrl+X / ⌘X."
        : "Couldn't reach the clipboard. Try Ctrl+C / ⌘C.",
      "error",
    );
    return false;
  }
  if (cut) deleteSelected(store);
  else store.toast("Copied to clipboard.", "success", 2000);
  return true;
};

/** Board point where pasted content goes: the pointer if over the canvas, else the view centre. */
const pastePoint = (store: Store) =>
  screenToScene(store.lastPointer ?? viewCenter(store), store.get().viewport);

export const insertText = (store: Store, text: string) => {
  if (blockedByViewMode(store)) return;
  const p = pastePoint(store);
  const { currentStyle, elements } = store.get();
  const el = layoutText(createText(p.x, p.y, { ...currentStyle, textAlign: "left" }, text));
  const placed = { ...el, x: p.x - el.width / 2, y: p.y - el.height / 2 };
  store.commit([...elements, placed], { selectedIds: new Set([placed.id]), tool: "pick" });
};

export const insertImageBlob = async (store: Store, blob: Blob) => {
  if (blockedByViewMode(store)) return;
  let dataURL: string;
  let size: { width: number; height: number };
  try {
    dataURL = await blobToDataURL(blob);
    size = await imageSize(dataURL);
  } catch {
    store.toast("That image could not be read. The board was not changed.", "error");
    return;
  }
  const max = 480 / store.get().viewport.zoom;
  const s = Math.min(1, max / Math.max(size.width, size.height));
  const w = Math.max(1, size.width * s);
  const h = Math.max(1, size.height * s);
  const p = pastePoint(store);
  const fileId = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const el = createImage(p.x - w / 2, p.y - h / 2, w, h, fileId);
  if (store.get().viewMode) return; // turned on while the picture was loading
  const { elements, files } = store.get();
  store.history.record(store.snapshot());
  store.set({
    files: { ...files, [fileId]: { id: fileId, mimeType: blob.type || "image/png", dataURL } },
    elements: [...elements, el],
    selectedIds: new Set([el.id]),
    tool: "pick",
    historyVersion: store.get().historyVersion + 1,
  });
};

export const pasteContent = async (store: Store, content: PasteContent) => {
  if (blockedByViewMode(store)) return;
  switch (content.kind) {
    case "empty":
      store.toast("The clipboard is empty, so there is nothing to paste.");
      return;
    case "unsupported":
      store.toast(content.detail, "error");
      return;
    case "text":
      insertText(store, content.text);
      return;
    case "image":
      await insertImageBlob(store, content.blob);
      return;
    case "scene": {
      const { elements, files } = content.payload;
      const b = getCommonBounds(elements);
      if (!b) {
        store.toast("The clipboard is empty, so there is nothing to paste.");
        return;
      }
      const p = pastePoint(store);
      const { clones, idMap } = cloneElements(
        elements,
        p.x - (b.minX + b.maxX) / 2,
        p.y - (b.minY + b.maxY) / 2,
      );
      const state = store.get();
      const topIds = elements
        .filter((e) => !(e.type === "text" && e.containerId))
        .map((e) => idMap.get(e.id)!);
      store.history.record(store.snapshot());
      store.set({
        files: { ...state.files, ...files },
        historyVersion: state.historyVersion + 1,
      });
      store.updateElements([...state.elements, ...clones]);
      store.set({ selectedIds: new Set(topIds), tool: "pick" });
      return;
    }
  }
};

export const pasteWithApi = async (store: Store) => {
  if (blockedByViewMode(store)) return;
  await pasteContent(store, await readClipboardApi());
};

export const clearCanvas = (store: Store) => {
  if (blockedByViewMode(store)) return store.set({ dialog: null });
  // removes every element, including locked ones; undoable
  store.commit([], { selectedIds: new Set(), editingTextId: null, dialog: null });
  store.toast("The board was cleared. Undo brings it back.", "info");
};

// ---- arranging (P1) ----

type Arranger = (
  elements: readonly SceneElement[],
  ids: ReadonlySet<string>,
) => SceneElement[] | null;

const arrange = (
  store: Store,
  fn: Arranger,
  emptyMessage: string,
  extra: Partial<AppState> = {},
) => {
  const { elements, selectedIds } = store.get();
  if (blockedByViewMode(store)) return false;
  if (!selectedIds.size) {
    store.toast("Select something first.");
    return false;
  }
  const next = fn(elements, selectedIds);
  if (!next) {
    store.toast(emptyMessage);
    return false;
  }
  store.commit(next, extra);
  return true;
};

export const groupSelected = (store: Store) =>
  arrange(store, groupElements, "Pick two or more unlocked items to group.");

export const ungroupSelected = (store: Store) =>
  arrange(store, ungroupElements, "The selection is not grouped.");

export const reorderSelected = (store: Store, op: ZOrder) =>
  arrange(store, (els, ids) => reorder(els, ids, op), "Nothing to reorder.");

export const alignSelected = (store: Store, mode: Align) =>
  arrange(store, (els, ids) => alignElements(els, ids, mode), "Pick two or more items to align.");

export const distributeSelected = (store: Store, axis: "horizontal" | "vertical") =>
  arrange(
    store,
    (els, ids) => distributeElements(els, ids, axis),
    "Pick three or more items to distribute.",
  );

export const flipSelected = (store: Store, axis: "horizontal" | "vertical") =>
  arrange(store, (els, ids) => flipElements(els, ids, axis), "Nothing to flip.");

export const lockSelected = (store: Store) =>
  arrange(store, (els, ids) => setLocked(els, ids, true), "Already locked.", {
    selectedIds: new Set(),
  }) &&
  store.toast(
    "Locked. Double-click it to unlock it, or use “Unlock all” in the menu.",
    "info",
    3000,
  );

export const lockAll = (store: Store) => {
  if (blockedByViewMode(store)) return;
  const next = setLocked(store.get().elements, "all", true);
  if (!next) return store.toast("Everything is already locked.");
  store.commit(next, { selectedIds: new Set() });
  store.toast("Every item is locked.", "info", 2500);
};

export const unlockAll = (store: Store) => {
  if (blockedByViewMode(store)) return;
  const { elements } = store.get();
  const ids = new Set(elements.filter((e) => e.locked).map((e) => e.id));
  const next = setLocked(elements, "all", false);
  if (!next) return store.toast("Nothing is locked.");
  store.commit(next, { selectedIds: ids, tool: "pick" });
};

/** Unlocks one locked item (picked from the canvas context command). */
export const unlockElement = (store: Store, id: string) => {
  if (blockedByViewMode(store)) return;
  const next = setLocked(store.get().elements, new Set([id]), false);
  if (next) store.commit(next, { selectedIds: new Set([id]) });
};

export const switchSelectedType = (store: Store, type: ShapeType | "arrow" | "line") =>
  arrange(
    store,
    (els, ids) => switchType(els, ids, type),
    "That shape cannot switch to this type.",
  );

export const copyStyles = (store: Store) => {
  const { elements, selectedIds } = store.get();
  const el = elements.find((e) => selectedIds.has(e.id));
  if (!el) return store.toast("Select an item to copy its style.");
  const style = extractStyle(el);
  const text = getBoundText(elements, el.id);
  if (text) Object.assign(style, { fontFamily: text.fontFamily, fontSize: text.fontSize });
  store.set({ copiedStyle: style });
  store.toast("Style copied.", "success", 1800);
};

export const pasteStyles = (store: Store) => {
  if (blockedByViewMode(store)) return;
  const { copiedStyle } = store.get();
  if (!copiedStyle) return store.toast("Copy a style first.");
  arrange(
    store,
    (els, ids) => pasteStyle(els, ids, copiedStyle),
    "Those items already use this style.",
  );
};

export const setLink = (store: Store, id: string, raw: string): string | null => {
  if (store.get().viewMode) return "Look-only mode is on. Leave it to change links.";
  const { elements } = store.get();
  if (!raw.trim()) {
    store.commit(elements.map((e) => (e.id === id ? { ...e, link: null } : e)));
    return null;
  }
  const link = normalizeLink(raw);
  if (!link) return "That link is not allowed. Use http(s), mailto, or an internal board link.";
  store.commit(elements.map((e) => (e.id === id ? { ...e, link } : e)));
  return null;
};

/** Opens a link deliberately. Internal links move the view to the target. */
export const followLink = (store: Store, link: string, win: Window | null) => {
  const target = internalTarget(link);
  if (target) {
    const el = store.get().elements.find((e) => e.id === target);
    if (!el) {
      store.toast("The linked item is no longer on this board.", "error");
      return;
    }
    const v = fitBounds(getCommonBounds([el]), store.viewSize.width, store.viewSize.height);
    if (v) store.set({ viewport: { ...v, zoom: Math.min(v.zoom, 1.5) } });
    if (!store.get().viewMode) store.set({ selectedIds: new Set([el.id]), tool: "pick" });
    return;
  }
  if (!normalizeLink(link)) {
    store.toast("That link is not safe to open.", "error");
    return;
  }
  win?.open(link, "_blank", "noopener,noreferrer");
};

export const deletePoint = (store: Store) => {
  if (store.get().viewMode) return false;
  const { elements, editingPointsId, editingPointIndex } = store.get();
  const el = elements.find((e) => e.id === editingPointsId);
  if (!el || !isLinear(el) || editingPointIndex === null) return false;
  const next = removePoint(el, editingPointIndex);
  if (!next) {
    store.toast("A path needs at least two points, so this point stays.");
    return true;
  }
  store.commit(
    elements.map((e) => (e.id === el.id ? next : e)),
    { editingPointIndex: null },
  );
  return true;
};

export const resetImageCrop = (store: Store) =>
  arrange(
    store,
    (els, ids) => {
      let changed = false;
      const next = els.map((e) => {
        if (!ids.has(e.id) || e.type !== "image" || !e.crop) return e;
        changed = true;
        return resetCrop(e);
      });
      return changed ? next : null;
    },
    "This picture is not cropped.",
    { croppingId: null },
  );

export const createFrameAroundSelection = (store: Store) => {
  if (blockedByViewMode(store)) return;
  const { elements, selectedIds } = store.get();
  const items = elements.filter((e) => selectedIds.has(e.id) && e.type !== "frame");
  const b = getCommonBounds(items);
  if (!b) return store.toast("Select items to wrap in a page frame.");
  const pad = 24;
  const count = elements.filter((e) => e.type === "frame").length;
  const frame = {
    ...createFrame(b.minX - pad, b.minY - pad, `Page ${count + 1}`),
    width: b.maxX - b.minX + pad * 2,
    height: b.maxY - b.minY + pad * 2,
  };
  store.commit(assignFrames([frame, ...elements]), { selectedIds: new Set([frame.id]) });
};

export const setFrameName = (store: Store, id: string, name: string) => {
  if (blockedByViewMode(store)) return;
  const { elements } = store.get();
  store.commit(elements.map((e) => (e.id === id && e.type === "frame" ? { ...e, name } : e)));
};

/** Removes a frame but keeps everything that was inside it. */
export const removeFrameKeepContents = (store: Store, id: string) => {
  if (blockedByViewMode(store)) return;
  const { elements } = store.get();
  store.commit(
    elements
      .filter((e) => e.id !== id)
      .map((e) => (e.frameId === id ? { ...e, frameId: null } : e)),
    { selectedIds: new Set() },
  );
};

/** Copies the selection (or the whole board) as PNG, SVG or plain text. */
export const copySelectionAs = async (store: Store, kind: CopyKind) => {
  const s = store.get();
  const elements = selectionTargets(s.elements, s.selectedIds);
  const res = await copyAs(
    kind,
    {
      elements,
      files: s.files,
      theme: s.theme,
      background: true,
      boardColor: s.viewBackgroundColor,
      scale: 2,
      embedScene: false,
      settings: store.boardSettings(),
    },
    store.ownerWindow?.navigator.clipboard,
  );
  if (res.ok) {
    const what = s.selectedIds.size ? "Selection" : "Board";
    store.toast(
      `${what} copied as ${kind === "text" ? "text" : kind.toUpperCase()}.`,
      "success",
      2000,
    );
  } else store.toast(res.message, "error", 5000);
  return res.ok;
};
