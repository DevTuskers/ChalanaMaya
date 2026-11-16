import { describe, expect, it } from "vitest";
import { createShape } from "../scene/elements";
import type { SceneElement, TextElement } from "../scene/types";
import { applyStyle, redo, undo } from "../store/actions";
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

const texts = (store: Store) =>
  store.get().elements.filter((e): e is TextElement => e.type === "text");

/** Compact description of the board, used to compare history states. */
const describeBoard = (elements: readonly SceneElement[]) =>
  elements
    .map((e) =>
      e.type === "text" ? `text:${e.text}/${e.fontFamily}/${e.fontSize}/${e.textAlign}` : e.type,
    )
    .join(",");

describe("text editing and history", () => {
  it("style changes made while editing a box label undo and redo in linear order", () => {
    const { store, controller } = setup();
    const box = { ...createShape("rectangle", 0, 0), width: 150, height: 80 };
    store.commit([box]); // state 1: box
    const s1 = describeBoard(store.get().elements);

    controller.editContainerText(box);
    const id = store.get().editingTextId!;
    controller.updateText(id, "hello");
    applyStyle(store, { fontFamily: "code" });
    applyStyle(store, { fontSize: 40 });
    controller.finishTextEdit(); // state 2: box + text code/40
    const s2 = describeBoard(store.get().elements);
    expect(texts(store)[0]).toMatchObject({ text: "hello", fontFamily: "code", fontSize: 40 });

    undo(store);
    expect(describeBoard(store.get().elements)).toBe(s1);
    undo(store);
    expect(store.get().elements).toHaveLength(0);
    expect(store.undo()).toBe(false);

    redo(store);
    expect(describeBoard(store.get().elements)).toBe(s1);
    redo(store);
    expect(describeBoard(store.get().elements)).toBe(s2);
    expect(store.redo()).toBe(false);
  });

  it("editing existing text with an align change is a single undo step", () => {
    const { store, controller } = setup();
    controller.createTextAt({ x: 10, y: 10 });
    const id = store.get().editingTextId!;
    controller.updateText(id, "abc");
    controller.finishTextEdit();
    const s1 = describeBoard(store.get().elements);
    expect(s1).toBe("text:abc/hand/20/left");

    controller.startTextEdit(id);
    controller.updateText(id, "abcdef");
    applyStyle(store, { textAlign: "center" });
    controller.finishTextEdit();
    const s2 = describeBoard(store.get().elements);
    expect(s2).toBe("text:abcdef/hand/20/center");

    undo(store);
    expect(describeBoard(store.get().elements)).toBe(s1);
    undo(store);
    expect(store.get().elements).toHaveLength(0);
    expect(store.undo()).toBe(false);
    redo(store);
    redo(store);
    expect(describeBoard(store.get().elements)).toBe(s2);
  });

  it("style changes outside a text edit still record their own history entry", () => {
    const { store } = setup();
    const box = { ...createShape("rectangle", 0, 0), width: 100, height: 80 };
    store.commit([box], { selectedIds: new Set([box.id]) });
    applyStyle(store, { strokeWidth: 4 });
    expect(store.get().elements[0]).toMatchObject({ strokeWidth: 4 });
    undo(store);
    expect(store.get().elements[0]).toMatchObject({ strokeWidth: box.strokeWidth });
  });
});

describe("pointer gestures", () => {
  it("resizing follows the pointer delta, not the padded handle position", () => {
    const { store, controller } = setup();
    const box = { ...createShape("rectangle", 0, 0), width: 150, height: 100 };
    store.commit([box], { selectedIds: new Set([box.id]) });
    // the SE handle sits 6 px outside the corner at zoom 1
    controller.pointerDown(input(156, 106));
    controller.pointerMove(input(206, 106));
    controller.pointerUp(input(206, 106));
    const el = store.get().elements[0];
    expect(el.width).toBeCloseTo(200);
    expect(el.height).toBeCloseTo(100);
  });

  it("caps zoom change per wheel notch but keeps small pinch steps fine", () => {
    const { store, controller } = setup();
    const wheel = (deltaY: number) =>
      controller.wheel({
        x: 0,
        y: 0,
        deltaX: 0,
        deltaY,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      });
    wheel(-200);
    expect(store.get().viewport.zoom).toBeCloseTo(1.2);
    store.set({ viewport: { scrollX: 0, scrollY: 0, zoom: 1 } });
    wheel(-3);
    expect(store.get().viewport.zoom).toBeCloseTo(Math.exp(0.03));
  });

  it("cancel restores the board during a drag", () => {
    const { store, controller } = setup();
    const box = { ...createShape("rectangle", 0, 0), width: 100, height: 100 };
    store.commit([box], { selectedIds: new Set([box.id]) });
    controller.pointerDown(input(50, 50));
    controller.pointerMove(input(150, 150));
    expect(store.get().elements[0].x).toBe(100);
    controller.cancel();
    expect(store.get().elements[0].x).toBe(0);
    expect(controller.isBusy()).toBe(false);
  });
});
