import { createImage, createText, hasPoints, isFillable, isShape } from "../scene/elements";
import { getCommonBounds } from "../scene/geometry";
import {
  cloneElements,
  deleteElements,
  duplicateElements,
  selectAll as selectAllIds,
  withBoundTexts,
} from "../scene/scene";
import { layoutText } from "../scene/text";
import type { ItemStyle, SceneElement, TextElement } from "../scene/types";
import { clampZoom, fitBounds, screenToScene, zoomAt } from "../scene/viewport";
import {
  blobToDataURL,
  imageSize,
  readClipboardApi,
  writeClipboardText,
  type PasteContent,
} from "../io/clipboard";
import { serializeClipboard } from "../io/serialize";
import type { Store, ToolId } from "./store";

export const viewCenter = (store: Store) => ({
  x: store.viewSize.width / 2,
  y: store.viewSize.height / 2,
});

export const setTool = (store: Store, tool: ToolId) => {
  const patch: Parameters<Store["set"]>[0] = { tool, menuOpen: false };
  if (tool !== "pick") patch.selectedIds = new Set();
  store.set(patch);
};

export const undo = (store: Store) => {
  if (!store.undo()) store.toast("Nothing to undo.");
};

export const redo = (store: Store) => {
  if (!store.redo()) store.toast("Nothing to redo.");
};

export const selectAll = (store: Store) => {
  store.set({ selectedIds: new Set(selectAllIds(store.get().elements)), tool: "pick" });
};

export const deleteSelected = (store: Store) => {
  const { elements, selectedIds } = store.get();
  if (!selectedIds.size) return;
  store.commit(deleteElements(elements, selectedIds), { selectedIds: new Set() });
};

export const duplicateSelected = (store: Store) => {
  const { elements, selectedIds } = store.get();
  if (!selectedIds.size) return;
  const res = duplicateElements(elements, selectedIds);
  store.commit(res.elements, { selectedIds: new Set(res.newIds) });
};

/** Changes the current style and applies it to the matching selected elements. */
export const applyStyle = (store: Store, patch: Partial<ItemStyle>) => {
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
  const targets = withBoundTexts(elements, selectedIds);
  let changed = false;
  const next = elements.map((el): SceneElement => {
    if (!targets.has(el.id) || el.locked) return el;
    let out: SceneElement = el;
    if (patch.strokeColor !== undefined && el.type !== "image") {
      out = { ...out, strokeColor: patch.strokeColor };
    }
    if (patch.backgroundColor !== undefined && isFillable(el)) {
      out = { ...out, backgroundColor: patch.backgroundColor };
    }
    if (patch.strokeWidth !== undefined && (isShape(el) || hasPoints(el))) {
      out = { ...out, strokeWidth: patch.strokeWidth };
    }
    if (out.type === "text") {
      const t = out as TextElement;
      const textPatch: Partial<TextElement> = {};
      if (patch.fontFamily !== undefined) textPatch.fontFamily = patch.fontFamily;
      if (patch.fontSize !== undefined) textPatch.fontSize = patch.fontSize;
      if (patch.textAlign !== undefined) textPatch.textAlign = patch.textAlign;
      if (Object.keys(textPatch).length) {
        const merged = { ...t, ...textPatch };
        out = merged.containerId ? merged : layoutText(merged);
      }
    }
    if (out !== el) changed = true;
    return out;
  });
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
  const p = pastePoint(store);
  const { currentStyle, elements } = store.get();
  const el = layoutText(createText(p.x, p.y, { ...currentStyle, textAlign: "left" }, text));
  const placed = { ...el, x: p.x - el.width / 2, y: p.y - el.height / 2 };
  store.commit([...elements, placed], { selectedIds: new Set([placed.id]), tool: "pick" });
};

export const insertImageBlob = async (store: Store, blob: Blob) => {
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

export const pasteWithApi = async (store: Store) => pasteContent(store, await readClipboardApi());

export const clearCanvas = (store: Store) => {
  // removes every element, including locked ones; undoable
  store.commit([], { selectedIds: new Set(), editingTextId: null, dialog: null });
  store.toast("The board was cleared. Undo brings it back.", "info");
};
