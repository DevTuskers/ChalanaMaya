import { describe, expect, it } from "vitest";
import { createShape } from "../scene/elements";
import { insertChart, insertWebCard, pasteContent, undo } from "../store/actions";
import { parseSpreadsheet } from "../scene/chart";
import { Store, initialState } from "../store/store";
import { Controller, steadyPressure, type PointerInput } from "./controller";

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

const strokeBox = (c: Controller, x: number, y: number, w: number, h: number) => {
  const pts: [number, number][] = [];
  const edge = (ax: number, ay: number, bx: number, by: number) => {
    for (let i = 0; i < 12; i++) pts.push([ax + ((bx - ax) * i) / 12, ay + ((by - ay) * i) / 12]);
  };
  edge(x, y, x + w, y);
  edge(x + w, y, x + w, y + h);
  edge(x + w, y + h, x, y + h);
  edge(x, y + h, x, y);
  c.pointerDown(input(x, y));
  for (const [px, py] of pts.slice(1)) c.pointerMove(input(px, py));
  c.pointerUp(input(x, y));
};

describe("Shape tidy tool", () => {
  it("turns a sketched box into an editable box, and undo brings the sketch back", () => {
    const { store, controller } = setup();
    store.set({ tool: "tidy" });
    strokeBox(controller, 100, 100, 200, 120);
    const els = store.get().elements;
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ type: "rectangle", x: 100, y: 100, width: 200, height: 120 });
    undo(store);
    expect(store.get().elements.map((e) => e.type)).toEqual(["freedraw"]);
    undo(store);
    expect(store.get().elements).toHaveLength(0);
  });
  it("keeps an unrecognised stroke as a sketch", () => {
    const { store, controller } = setup();
    store.set({ tool: "tidy" });
    controller.pointerDown(input(0, 0));
    for (let i = 1; i < 30; i++) controller.pointerMove(input(i * 8, (i % 2) * 40));
    controller.pointerUp(input(240, 0));
    expect(store.get().elements.map((e) => e.type)).toEqual(["freedraw"]);
  });
});

describe("Pour colour tool", () => {
  it("fills a closed shape with the current fill as one undoable step", () => {
    const { store, controller } = setup();
    const box = { ...createShape("rectangle", 0, 0), width: 100, height: 100 };
    const other = { ...createShape("ellipse", 300, 0), width: 50, height: 50 };
    store.commit([box, other]);
    store.set({
      tool: "pour",
      currentStyle: { ...store.get().currentStyle, backgroundColor: "#ffd8a8", fillStyle: "solid" },
    });
    controller.pointerDown(input(50, 50));
    controller.pointerUp(input(50, 50));
    const [b, o] = store.get().elements;
    expect(b).toMatchObject({ backgroundColor: "#ffd8a8", fillStyle: "solid" });
    expect(o.backgroundColor).toBe(other.backgroundColor);
    undo(store);
    expect(store.get().elements[0].backgroundColor).toBe(box.backgroundColor);
  });
  it("leaves the board unchanged on empty space", () => {
    const { store, controller } = setup();
    const box = { ...createShape("rectangle", 0, 0), width: 100, height: 100 };
    store.commit([box]);
    const before = store.get().elements;
    store.set({ tool: "pour" });
    controller.pointerDown(input(500, 500));
    controller.pointerUp(input(500, 500));
    expect(store.get().elements).toBe(before);
  });
});

describe("Spotlight tool", () => {
  it("draws a temporary trail without touching the board or history", () => {
    const { store, controller } = setup();
    const box = { ...createShape("rectangle", 0, 0), width: 100, height: 100 };
    store.commit([box]);
    const before = store.get().elements;
    const version = store.get().historyVersion;
    store.set({ tool: "laser" });
    controller.pointerDown(input(10, 10));
    controller.pointerMove(input(60, 60));
    controller.pointerMove(input(120, 80));
    controller.pointerUp(input(120, 80));
    expect(store.get().spotlight[0].points).toHaveLength(3);
    expect(store.get().elements).toBe(before);
    expect(store.get().historyVersion).toBe(version);
  });
  it("works in look-only mode", () => {
    const { store, controller } = setup();
    store.set({ viewMode: true, tool: "laser" });
    controller.pointerDown(input(10, 10));
    controller.pointerMove(input(40, 40));
    controller.pointerUp(input(40, 40));
    expect(store.get().spotlight).toHaveLength(1);
    expect(store.get().viewport).toEqual({ scrollX: 0, scrollY: 0, zoom: 1 });
  });
});

describe("Pencil pressure", () => {
  const draw = (store: Store, c: Controller, extra: (i: number) => Partial<PointerInput>) => {
    store.set({ tool: "freedraw" });
    c.pointerDown(input(0, 0, extra(0)));
    for (let i = 1; i < 6; i++) c.pointerMove(input(i * 10, 0, extra(i)));
    c.pointerUp(input(50, 0, extra(6)));
    return store.get().elements[0] as { pressures?: number[] | null };
  };
  it("records stylus pressure when turned on", () => {
    const { store, controller } = setup();
    const el = draw(store, controller, (i) => ({ pointerType: "pen", pressure: 0.1 + i * 0.1 }));
    expect(el.pressures).toHaveLength(6);
  });
  it("draws a steady width when pressure is off or missing", () => {
    const a = setup();
    a.store.set({ prefs: { ...a.store.get().prefs, pencilPressure: false } });
    expect(
      draw(a.store, a.controller, () => ({ pointerType: "pen", pressure: 0.7 })).pressures,
    ).toBeUndefined();
    const b = setup();
    expect(
      draw(b.store, b.controller, () => ({ pointerType: "mouse", pressure: 0.5 })).pressures,
    ).toBeUndefined();
    const c = setup();
    expect(
      draw(c.store, c.controller, () => ({ pointerType: "pen", pressure: 0.5 })).pressures,
    ).toBeUndefined();
    expect(steadyPressure([0.5, 0.5, 0.5], 3)).toBeNull();
    expect(steadyPressure([0.2, 0.8], 3)).toEqual([0.2, 0.8, 0.8]);
  });
});

describe("Web card tool", () => {
  it("asks for an address where the board was clicked", () => {
    const { store, controller } = setup();
    store.set({ tool: "embed" });
    controller.pointerDown(input(200, 150));
    expect(store.get().dialog).toEqual({ kind: "webcard", at: { x: 200, y: 150 } });
    expect(store.get().elements).toHaveLength(0);
  });
});

describe("Web card and chart actions", () => {
  it("adds a web card for a valid link and explains bad ones", () => {
    const { store } = setup();
    expect(insertWebCard(store, { x: 0, y: 0 }, "nope")).toMatch(/valid web address/);
    expect(store.get().elements).toHaveLength(0);
    expect(insertWebCard(store, { x: 0, y: 0 }, "https://youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(store.get().elements[0]).toMatchObject({ type: "embed", width: 480, height: 300 });
  });
  it("opens a chart preview for pasted rows and adds the chart in one step", async () => {
    const { store } = setup();
    await pasteContent(store, { kind: "text", text: "A\t1\nB\t2\nC\t3" });
    expect(store.get().dialog).toMatchObject({ kind: "chart" });
    expect(store.get().elements).toHaveLength(0);
    const r = parseSpreadsheet("A\t1\nB\t2\nC\t3");
    if (!r.ok) throw new Error("parse");
    insertChart(store, r.data, "radar");
    expect(store.get().elements.length).toBeGreaterThan(3);
    expect(store.get().dialog).toBeNull();
    undo(store);
    expect(store.get().elements).toHaveLength(0);
  });
});
