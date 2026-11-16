import { describe, expect, it } from "vitest";
import { createLinear, createShape, createText } from "./elements";
import {
  boundsOfPoints,
  distanceToSegment,
  getAbsolutePoints,
  getCommonBounds,
  getElementBounds,
  normalizeRect,
  pointInPolygon,
  rotatePoint,
  snapAngle,
} from "./geometry";
import { History } from "./history";
import { elementAt, elementsInBox } from "./hit";
import {
  bindingTargetAt,
  deleteElements,
  duplicateElements,
  finalizeScene,
  getBoundText,
  selectAll,
} from "./scene";
import { moveElements, resizeElement, rotateElements } from "./transform";
import { fitBounds, panBy, sceneToScreen, screenToScene, zoomAt } from "./viewport";
import { MAX_ZOOM, MIN_ZOOM } from "./constants";
import type { LinearElement, SceneElement } from "./types";

const box = (x: number, y: number, w = 100, h = 80) => ({
  ...createShape("rectangle", x, y),
  width: w,
  height: h,
});

describe("geometry", () => {
  it("rotates points around a centre", () => {
    const p = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(10);
  });

  it("measures distance to segments", () => {
    expect(distanceToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it("tests points in polygons", () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 5, y: 5 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, sq)).toBe(false);
  });

  it("normalises rectangles dragged in any direction", () => {
    expect(normalizeRect({ x: 10, y: 20 }, { x: 0, y: 5 })).toEqual({
      minX: 0,
      minY: 5,
      maxX: 10,
      maxY: 20,
    });
  });

  it("computes rotated bounds", () => {
    const el = { ...box(0, 0, 100, 100), angle: Math.PI / 4 };
    const b = getElementBounds(el);
    expect(b.maxX - b.minX).toBeCloseTo(100 * Math.SQRT2);
  });

  it("computes common bounds and handles empty input", () => {
    expect(getCommonBounds([])).toBeNull();
    expect(getCommonBounds([box(0, 0), box(200, 100)])).toEqual({
      minX: 0,
      minY: 0,
      maxX: 300,
      maxY: 180,
    });
    expect(
      boundsOfPoints([
        { x: 1, y: 2 },
        { x: -1, y: 5 },
      ]),
    ).toEqual({ minX: -1, minY: 2, maxX: 1, maxY: 5 });
  });

  it("snaps angles to 15° steps", () => {
    expect(snapAngle((14 * Math.PI) / 180)).toBeCloseTo((15 * Math.PI) / 180);
  });
});

describe("hit testing", () => {
  it("hits outlines of unfilled shapes but not their empty middle", () => {
    const el = box(0, 0);
    expect(elementAt([el], { x: 0, y: 40 }, 4)?.id).toBe(el.id);
    expect(elementAt([el], { x: 50, y: 40 }, 4)).toBeNull();
  });

  it("hits filled shapes anywhere inside", () => {
    const el = { ...box(0, 0), backgroundColor: "#bfe8e2" };
    expect(elementAt([el], { x: 50, y: 40 }, 4)?.id).toBe(el.id);
  });

  it("returns the topmost element", () => {
    const a = { ...box(0, 0), backgroundColor: "#bfe8e2" };
    const b = { ...box(20, 20), backgroundColor: "#bfe8e2" };
    expect(elementAt([a, b], { x: 50, y: 50 }, 4)?.id).toBe(b.id);
  });

  it("skips locked elements and selects fully enclosed ones", () => {
    const locked = { ...box(0, 0), locked: true, backgroundColor: "#bfe8e2" };
    expect(elementAt([locked], { x: 50, y: 40 }, 4)).toBeNull();
    const a = box(10, 10, 20, 20);
    const b = box(100, 100, 50, 50);
    const found = elementsInBox([a, b], { minX: 0, minY: 0, maxX: 50, maxY: 50 });
    expect(found.map((e) => e.id)).toEqual([a.id]);
  });
});

describe("transforms", () => {
  it("moves selected elements only", () => {
    const a = box(0, 0);
    const b = box(200, 0);
    const out = moveElements([a, b], new Set([a.id]), 10, 5);
    expect(out[0]).toMatchObject({ x: 10, y: 5 });
    expect(out[1]).toMatchObject({ x: 200, y: 0 });
  });

  it("resizes from a corner and flips cleanly past the anchor", () => {
    const el = box(0, 0, 100, 80);
    const r = resizeElement(el, "se", { x: 150, y: 120 }, false);
    expect(r).toMatchObject({ x: 0, y: 0, width: 150, height: 120 });
    const flipped = resizeElement(el, "se", { x: -50, y: -20 }, false);
    expect(flipped.width).toBeGreaterThan(0);
    expect(flipped.x).toBeLessThan(0);
  });

  it("keeps proportions with shift", () => {
    const el = box(0, 0, 100, 50);
    const r = resizeElement(el, "se", { x: 200, y: 60 }, true);
    expect(r.width / r.height).toBeCloseTo(2);
  });

  it("rotates around a centre", () => {
    const el = box(0, 0);
    const [r] = rotateElements([el], new Set([el.id]), { x: 50, y: 40 }, Math.PI / 2);
    expect(r.angle).toBeCloseTo(Math.PI / 2);
  });
});

describe("scene operations", () => {
  it("deletes and duplicates together with bound text", () => {
    const shape = box(0, 0);
    const label = { ...createText(0, 0, undefined, "Hi"), containerId: shape.id };
    const els = finalizeScene([shape, label]);
    expect(getBoundText(els, shape.id)?.text).toBe("Hi");
    expect(deleteElements(els, [shape.id])).toHaveLength(0);
    const dup = duplicateElements(els, [shape.id]);
    expect(dup.elements).toHaveLength(4);
    const copyShape = dup.elements.find((e) => e.id === dup.newIds[0])!;
    expect(getBoundText(dup.elements, copyShape.id)).toBeDefined();
    expect(copyShape.x).toBe(16);
  });

  it("does not delete locked elements", () => {
    const locked = { ...box(0, 0), locked: true };
    expect(deleteElements([locked], [locked.id])).toHaveLength(1);
  });

  it("select all skips locked and bound text", () => {
    const shape = box(0, 0);
    const label = { ...createText(0, 0, undefined, "Hi"), containerId: shape.id };
    const locked = { ...box(300, 0), locked: true };
    expect(selectAll([shape, label, locked])).toEqual([shape.id]);
  });

  it("keeps bound arrows attached when shapes move", () => {
    const a = box(0, 0);
    const b = box(300, 0);
    const arrow: LinearElement = {
      ...createLinear("arrow", 100, 40, undefined, [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ]),
      startBinding: { elementId: a.id },
      endBinding: { elementId: b.id },
    };
    let els: SceneElement[] = finalizeScene([a, b, arrow]);
    els = finalizeScene(moveElements(els, new Set([b.id]), 0, 200));
    const moved = els.find((e) => e.id === arrow.id) as LinearElement;
    const pts = getAbsolutePoints(moved);
    const end = pts[pts.length - 1];
    expect(end.y).toBeGreaterThan(200);
    expect(end.x).toBeGreaterThan(290);
  });

  it("deleting a bound shape releases the connector", () => {
    const a = box(0, 0);
    const arrow: LinearElement = {
      ...createLinear("arrow", 100, 40, undefined, [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
      ]),
      startBinding: { elementId: a.id },
    };
    const out = deleteElements([a, arrow], [a.id]);
    expect(out).toHaveLength(1);
    expect((out[0] as LinearElement).startBinding).toBeNull();
  });

  it("finds binding targets near shapes", () => {
    const a = box(0, 0);
    expect(bindingTargetAt([a], { x: 50, y: 40 })?.id).toBe(a.id);
    expect(bindingTargetAt([a], { x: 500, y: 40 })).toBeNull();
  });
});

describe("history", () => {
  const snap = (n: number) => ({ elements: Array.from({ length: n }, () => box(0, 0)), files: {} });

  it("undoes and redoes in order", () => {
    const h = new History();
    const s0 = snap(0);
    const s1 = snap(1);
    const s2 = snap(2);
    h.record(s0);
    h.record(s1);
    expect(h.undo(s2)).toBe(s1);
    expect(h.undo(s1)).toBe(s0);
    expect(h.undo(s0)).toBeNull();
    expect(h.redo(s0)).toBe(s1);
    expect(h.canRedo).toBe(true);
  });

  it("clears the redo branch on a new edit", () => {
    const h = new History();
    h.record(snap(0));
    h.undo(snap(1));
    expect(h.canRedo).toBe(true);
    h.record(snap(0));
    expect(h.canRedo).toBe(false);
  });

  it("respects its limit", () => {
    const h = new History(2);
    h.record(snap(0));
    h.record(snap(1));
    h.record(snap(2));
    let n = 0;
    while (h.undo(snap(0))) n++;
    expect(n).toBe(2);
  });
});

describe("viewport", () => {
  it("round-trips screen and board coordinates", () => {
    const v = { scrollX: 30, scrollY: -10, zoom: 2 };
    const p = screenToScene({ x: 100, y: 50 }, v);
    expect(sceneToScreen(p, v)).toEqual({ x: 100, y: 50 });
  });

  it("zooms around the pointer", () => {
    const v = { scrollX: 0, scrollY: 0, zoom: 1 };
    const pivot = { x: 200, y: 100 };
    const before = screenToScene(pivot, v);
    const next = zoomAt(v, 2, pivot);
    const after = screenToScene(pivot, next);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps zoom limits", () => {
    const v = { scrollX: 0, scrollY: 0, zoom: 1 };
    expect(zoomAt(v, 1000, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(v, 0.0001, { x: 0, y: 0 }).zoom).toBe(MIN_ZOOM);
  });

  it("pans by screen pixels", () => {
    expect(panBy({ scrollX: 0, scrollY: 0, zoom: 2 }, 20, 10)).toEqual({
      scrollX: 10,
      scrollY: 5,
      zoom: 2,
    });
  });

  it("fits content into view and centres it", () => {
    const v = fitBounds({ minX: 1000, minY: 1000, maxX: 1200, maxY: 1100 }, 800, 600)!;
    const c = sceneToScreen({ x: 1100, y: 1050 }, v);
    expect(c.x).toBeCloseTo(400);
    expect(c.y).toBeCloseTo(300);
    expect(fitBounds(null, 800, 600)).toBeNull();
  });
});

describe("theme colours", () => {
  it("shows readable dark variants of palette inks without changing custom colours", async () => {
    const { resolveColor } = await import("../render/renderScene");
    expect(resolveColor("#007f78", "dark")).toBe("#5ad6c8");
    expect(resolveColor("#007f78", "light")).toBe("#007f78");
    expect(resolveColor("#123456", "dark")).toBe("#123456");
  });
});
