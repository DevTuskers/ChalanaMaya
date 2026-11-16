import { describe, expect, it } from "vitest";
import {
  acceptsStyle,
  alignElements,
  assignFrames,
  distributeElements,
  elementsInLasso,
  elementsUnderTrail,
  expandGroups,
  extractStyle,
  flipElements,
  groupElements,
  insertPoint,
  internalTarget,
  movePoint,
  normalizeLink,
  pasteStyle,
  removePoint,
  reorder,
  setLocked,
  snapBox,
  switchType,
  ungroupElements,
} from "./arrange";
import { cropByHandle, effectiveCrop, fullImageBox, resetCrop } from "./crop";
import {
  createFrame,
  createImage,
  createLinear,
  createNote,
  createShape,
  createText,
} from "./elements";
import { curveRoute, elbowRoute, polylineMidpoint, routedPoints } from "./route";
import { searchText } from "./search";
import type { SceneElement } from "./types";

const box = (id: string, x: number, y: number, w = 100, h = 80) => ({
  ...createShape("rectangle", x, y, undefined, w, h),
  id,
});
const ids = (...xs: string[]) => new Set(xs);

describe("connector routing", () => {
  it("elbow routes are orthogonal and keep the ends", () => {
    const pts = elbowRoute([
      { x: 0, y: 0 },
      { x: 100, y: 40 },
    ]);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 40 });
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it("curves pass through both ends and bow away from the straight line", () => {
    const pts = curveRoute([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ]);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1].x).toBeCloseTo(200);
    expect(pts.some((p) => Math.abs(p.y) > 1)).toBe(true);
  });

  it("routedPoints follows the element's routing and midpoint sits on the path", () => {
    const a = {
      ...createLinear("arrow", 10, 10),
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 50 },
      ],
    };
    expect(routedPoints(a)).toHaveLength(2);
    const elbow = routedPoints({ ...a, routing: "elbow" });
    expect(elbow.length).toBeGreaterThan(2);
    expect(elbow[0]).toEqual({ x: 10, y: 10 });
    expect(
      polylineMidpoint([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]),
    ).toEqual({ x: 50, y: 0 });
  });
});

describe("grouping and layers", () => {
  it("groups, expands and ungroups", () => {
    const els = [box("a", 0, 0), box("b", 200, 0), box("c", 400, 0)];
    const grouped = groupElements(els, ids("a", "b"))!;
    expect(grouped[0].groupIds).toHaveLength(1);
    expect(expandGroups(grouped, ["a"])).toEqual(ids("a", "b"));
    expect(groupElements(els, ids("a"))).toBeNull();
    const un = ungroupElements(grouped, ids("a", "b"))!;
    expect(un[0].groupIds).toHaveLength(0);
  });

  it("reorders front/back/forward/backward and keeps labels on their container", () => {
    const label = { ...createText(0, 0, undefined, "hi", "a"), id: "t" };
    const els: SceneElement[] = [box("a", 0, 0), label, box("b", 0, 0), box("c", 0, 0)];
    expect(reorder(els, ids("a"), "front")!.map((e) => e.id)).toEqual(["b", "c", "a", "t"]);
    expect(reorder(els, ids("c"), "back")!.map((e) => e.id)).toEqual(["c", "a", "t", "b"]);
    expect(reorder(els, ids("a"), "forward")!.map((e) => e.id)).toEqual(["b", "a", "t", "c"]);
    expect(reorder(els, ids("c"), "backward")!.map((e) => e.id)).toEqual(["a", "t", "c", "b"]);
  });

  it("locked items are not reordered", () => {
    const els = [{ ...box("a", 0, 0), locked: true }, box("b", 0, 0)];
    expect(reorder(els, ids("a"), "front")).toBeNull();
  });
});

describe("align, distribute and flip", () => {
  it("aligns to the selection edges", () => {
    const els = [box("a", 0, 0), box("b", 200, 50, 50, 50)];
    const left = alignElements(els, ids("a", "b"), "left")!;
    expect(left[1].x).toBe(0);
    const bottom = alignElements(els, ids("a", "b"), "bottom")!;
    expect(bottom[0].y + bottom[0].height).toBe(100);
    expect(alignElements(els, ids("a"), "left")).toBeNull();
  });

  it("distributes with equal gaps keeping the ends", () => {
    const els = [box("a", 0, 0, 50), box("b", 60, 0, 50), box("c", 300, 0, 50)];
    const out = distributeElements(els, ids("a", "b", "c"), "horizontal")!;
    expect(out[0].x).toBe(0);
    expect(out[2].x).toBe(300);
    expect(out[1].x).toBe(150);
  });

  it("flips positions across the selection centre and mirrors images", () => {
    const img = { ...createImage(200, 0, 100, 80, "f"), id: "i" };
    const out = flipElements([box("a", 0, 0), img], ids("a", "i"), "horizontal")!;
    expect(out[0].x).toBe(200);
    expect(out[1].x).toBe(0);
    expect((out[1] as typeof img).flipX).toBe(true);
  });
});

describe("locking and switching", () => {
  it("locks and unlocks", () => {
    const els = [box("a", 0, 0), box("b", 0, 0)];
    const locked = setLocked(els, ids("a"), true)!;
    expect(locked[0].locked).toBe(true);
    expect(setLocked(locked, "all", false)!.every((e) => !e.locked)).toBe(true);
  });

  it("switches shape types keeping size and text", () => {
    const out = switchType([box("a", 10, 10)], ids("a"), "ellipse")!;
    expect(out[0]).toMatchObject({ type: "ellipse", x: 10, width: 100 });
  });
});

describe("links", () => {
  it("accepts web, email and internal links; refuses unsafe ones", () => {
    expect(normalizeLink("example.com")).toBe("https://example.com/");
    expect(normalizeLink("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(normalizeLink("#el=abc")).toBe("#el=abc");
    expect(normalizeLink("javascript:alert(1)")).toBeNull();
    expect(normalizeLink("data:text/html,x")).toBeNull();
    expect(normalizeLink("   ")).toBeNull();
    expect(internalTarget("#el=abc")).toBe("abc");
    expect(internalTarget("https://x.y")).toBeNull();
  });
});

describe("eraser, lasso and frames", () => {
  it("eraser trail skips locked items", () => {
    const els = [box("a", 0, 0), { ...box("b", 200, 0), locked: true }];
    const trail = [
      { x: 0, y: 40 },
      { x: 200, y: 40 },
    ];
    expect([...elementsUnderTrail(els, trail, 4)]).toEqual(["a"]);
  });

  it("lasso selects only fully enclosed items; empty loops select nothing", () => {
    const els = [box("a", 10, 10, 50, 50), box("b", 90, 10, 100, 50)];
    const loop = [
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(elementsInLasso(els, loop)).toEqual(["a"]);
    expect(elementsInLasso(els, loop.slice(0, 2))).toEqual([]);
  });

  it("assigns items to the frame that contains them", () => {
    const frame = { ...createFrame(0, 0), id: "f", width: 300, height: 300 };
    const els = [frame, box("a", 20, 20), box("b", 500, 500)];
    const out = assignFrames(els);
    expect(out[1].frameId).toBe("f");
    expect(out[2].frameId).toBeNull();
  });
});

describe("snapping and point editing", () => {
  it("snaps a moving box to nearby edges and reports a guide", () => {
    const r = snapBox([box("a", 0, 0)], { minX: 103, maxX: 153, minY: 200, maxY: 250 }, ids(), 6);
    expect(r.dx).toBe(-3);
    expect(r.lines).toHaveLength(1);
    expect(
      snapBox([box("a", 0, 0)], { minX: 400, maxX: 450, minY: 400, maxY: 450 }, ids(), 6),
    ).toEqual({ dx: 0, dy: 0, lines: [] });
  });

  it("inserts, moves and removes path points", () => {
    const line = {
      ...createLinear("line", 0, 0),
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
    };
    const three = insertPoint(line, 0);
    expect(three.points).toHaveLength(3);
    expect(three.points[1]).toEqual({ x: 50, y: 0 });
    const bent = movePoint(three, 1, { x: 50, y: -40 });
    expect(bent.y).toBe(-40);
    const back = removePoint(bent, 1)!;
    expect(back.points).toHaveLength(2);
    expect(removePoint(back, 0)).toBeNull();
  });
});

describe("style copy and paste", () => {
  it("copies visual settings only and applies what each target supports", () => {
    const src = {
      ...box("a", 0, 0),
      fillStyle: "zigzag" as const,
      opacity: 40,
      roughness: 2 as const,
    };
    const style = extractStyle(src);
    expect(style).not.toHaveProperty("x");
    const note = { ...createNote(300, 0), id: "n" };
    const out = pasteStyle([src, box("b", 500, 500), note], ids("b", "n"), style)!;
    expect(out[1]).toMatchObject({ fillStyle: "zigzag", opacity: 40, x: 500 });
    expect(out[2].fillStyle).toBe("solid");
    expect(out[2].opacity).toBe(40);
    expect(acceptsStyle(note, "fillStyle")).toBe(false);
  });
});

describe("image crop", () => {
  it("crops without stretching and resets to the whole picture", () => {
    const img = createImage(0, 0, 200, 100, "f");
    const nat = { width: 400, height: 200 };
    const cropped = cropByHandle(img, nat, "e", { x: 100, y: 50 });
    expect(cropped.width).toBe(100);
    expect(cropped.crop).toMatchObject({ x: 0, width: 200, naturalWidth: 400 });
    const box2 = fullImageBox(cropped, effectiveCrop(cropped, nat));
    expect(box2.width).toBe(200);
    // cannot drag past the picture
    expect(cropByHandle(cropped, nat, "e", { x: 900, y: 50 }).width).toBe(200);
    const reset = resetCrop(cropped);
    expect(reset.crop).toBeNull();
    expect(reset.width).toBe(200);
  });
});

describe("search", () => {
  it("finds words case-insensitively, targeting containers and frames", () => {
    const frame = { ...createFrame(0, 0, "Roadmap"), id: "f" };
    const shape = box("s", 0, 200);
    const label = { ...createText(0, 200, undefined, "Ship the Map", "s"), id: "t" };
    const free = { ...createText(0, 400, undefined, "nothing here"), id: "u" };
    const hits = searchText([frame, shape, label, free], "MAP");
    expect(hits.map((h) => h.targetId)).toEqual(["f", "s"]);
    expect(hits[1].textId).toBe("t");
    expect(searchText([free], "  ")).toEqual([]);
  });
});
