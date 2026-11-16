import { describe, expect, it } from "vitest";
import { createFrame, createShape } from "../scene/elements";
import { lockedElementAt } from "../scene/hit";
import type { SceneElement } from "../scene/types";
import { exportToSvg } from "../io/svg";
import {
  clearCanvas,
  deleteSelected,
  duplicateSelected,
  insertText,
  lockAll,
  pasteContent,
  redo,
  undo,
  unlockAll,
  unlockElement,
} from "../store/actions";
import { Store, initialState } from "../store/store";
import { Controller, type PointerInput } from "./controller";

const input = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({
  x,
  y,
  button: 0,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
});

const setup = () => {
  const store = new Store(initialState());
  const controller = new Controller(store);
  return { store, controller };
};

const box = (x = 0, y = 0, w = 100, h = 100): SceneElement => ({
  ...createShape("rectangle", x, y),
  width: w,
  height: h,
});

describe("look-only mode blocks board changes", () => {
  it("undo, redo, clear, lock, unlock, paste, insert, duplicate and delete do nothing", async () => {
    const { store } = setup();
    const a = box();
    const b = box(200, 0);
    store.commit([a]);
    store.commit([a, b]);
    undo(store);
    expect(store.get().elements).toHaveLength(1);
    store.set({ viewMode: true, selectedIds: new Set([a.id]) });
    const before = store.get().elements;

    redo(store);
    expect(store.get().elements).toBe(before);
    undo(store);
    expect(store.get().elements).toBe(before);
    clearCanvas(store);
    lockAll(store);
    unlockAll(store);
    unlockElement(store, a.id);
    insertText(store, "hello");
    await pasteContent(store, { kind: "text", text: "pasted" });
    duplicateSelected(store);
    deleteSelected(store);
    expect(store.get().elements).toBe(before);
    expect(store.get().elements[0].locked).toBe(false);

    // leaving look-only mode restores editing
    store.set({ viewMode: false });
    redo(store);
    expect(store.get().elements).toHaveLength(2);
  });

  it("double-click in look-only mode never starts a text edit", () => {
    const { store, controller } = setup();
    store.commit([box()]);
    store.set({ viewMode: true });
    controller.doubleClick(input(50, 50));
    controller.doubleClick(input(400, 400));
    expect(store.get().editingTextId).toBeNull();
    expect(store.get().elements).toHaveLength(1);
  });
});

describe("locked items refuse text editing", () => {
  it("does not open the label editor of a locked shape", () => {
    const { store, controller } = setup();
    const locked = { ...box(), locked: true };
    store.commit([locked]);
    controller.editContainerText(locked);
    expect(store.get().editingTextId).toBeNull();
    controller.doubleClick(input(50, 50));
    expect(store.get().editingTextId).toBeNull();
    expect(store.get().elements).toHaveLength(1);
  });

  it("does not edit the label of a locked container through its text", () => {
    const { store, controller } = setup();
    const shape = box();
    store.commit([shape]);
    controller.editContainerText(shape);
    const textId = store.get().editingTextId!;
    controller.updateText(textId, "label");
    controller.finishTextEdit();
    store.commit(store.get().elements.map((e) => (e.id === shape.id ? { ...e, locked: true } : e)));
    controller.startTextEdit(textId);
    expect(store.get().editingTextId).toBeNull();
  });

  it("offers to unlock just that item", () => {
    const { store, controller } = setup();
    const locked = { ...box(), locked: true };
    const other = { ...box(300, 0), locked: true };
    store.commit([locked, other]);
    expect(lockedElementAt(store.get().elements, { x: 50, y: 50 }, 2)?.id).toBe(locked.id);
    controller.doubleClick(input(50, 50));
    const toast = store.get().toasts.at(-1)!;
    expect(toast.action?.label).toBe("Unlock it");
    toast.action!.run();
    const els = store.get().elements;
    expect(els.find((e) => e.id === locked.id)!.locked).toBe(false);
    expect(els.find((e) => e.id === other.id)!.locked).toBe(true);
  });
});

describe("SVG export scale", () => {
  it("scales width and height but keeps the viewBox in board units", () => {
    const shape = box();
    const one = exportToSvg([shape], {}, { theme: "light", background: null });
    const two = exportToSvg([shape], {}, { theme: "light", background: null, scale: 2 });
    expect(one).toMatch(/^<svg[^>]* width="148" height="148" viewBox="0 0 148 148"/);
    expect(two).toMatch(/^<svg[^>]* width="296" height="296" viewBox="0 0 148 148"/);
  });
});

describe("drawing inside page frames and snapping", () => {
  it("a new item drawn inside a frame joins it", () => {
    const { store, controller } = setup();
    const frame = { ...createFrame(0, 0, "Page 1"), width: 400, height: 300 };
    store.commit([frame]);
    store.set({ tool: "rectangle" });
    controller.pointerDown(input(50, 50));
    controller.pointerMove(input(150, 150));
    controller.pointerUp(input(150, 150));
    const drawn = store.get().elements.find((e) => e.type === "rectangle")!;
    expect(drawn.frameId).toBe(frame.id);

    store.set({ tool: "rectangle" });
    controller.pointerDown(input(500, 500));
    controller.pointerMove(input(600, 600));
    controller.pointerUp(input(600, 600));
    const outside = store.get().elements.filter((e) => e.type === "rectangle")[1];
    expect(outside.frameId ?? null).toBeNull();
  });

  it("the first corner of a new box snaps to a nearby edge, and Alt skips it", () => {
    const { store, controller } = setup();
    store.commit([box(0, 200, 100, 100)]);
    store.set({ tool: "rectangle" });
    controller.pointerDown(input(300, 203));
    controller.pointerMove(input(400, 280, { altKey: true }));
    controller.pointerUp(input(400, 280, { altKey: true }));
    expect(store.get().elements[1].y).toBe(200);

    store.set({ tool: "rectangle" });
    controller.pointerDown(input(300, 403, { altKey: true }));
    controller.pointerMove(input(380, 480, { altKey: true }));
    controller.pointerUp(input(380, 480, { altKey: true }));
    expect(store.get().elements[2].y).toBe(403);
  });
});
