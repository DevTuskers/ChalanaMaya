import { describe, expect, it } from "vitest";
import { buildChart, chartKindProblem, looksLikeSpreadsheet, parseSpreadsheet } from "./chart";
import { createEmbed, createFreedraw, createLinear, createShape } from "./elements";
import { pourTargetAt } from "./hit";
import { recognizeShape } from "./recognize";
import { resolveWebCard } from "./webcard";
import { parseElement } from "../io/serialize";
import { centerViewportOn, minimapLayout, minimapToBoard } from "../render/minimap";
import { freedrawInput, freedrawOptions } from "../render/shapes";
import { pruneSpotlight, spotlightAlpha } from "../render/spotlight";
import type { Point } from "./types";

const ring = (f: (a: number) => Point, n = 64) =>
  Array.from({ length: n + 1 }, (_, i) => f((i / n) * Math.PI * 2));

const boxOutline = (x: number, y: number, w: number, h: number): Point[] => {
  const pts: Point[] = [];
  const edge = (a: Point, b: Point) => {
    for (let i = 0; i < 16; i++)
      pts.push({ x: a.x + ((b.x - a.x) * i) / 16, y: a.y + ((b.y - a.y) * i) / 16 });
  };
  edge({ x, y }, { x: x + w, y });
  edge({ x: x + w, y }, { x: x + w, y: y + h });
  edge({ x: x + w, y: y + h }, { x, y: y + h });
  edge({ x, y: y + h }, { x, y });
  pts.push({ x, y });
  return pts;
};

describe("Shape tidy recognition (DRAW-18)", () => {
  it("recognises a box", () => {
    const r = recognizeShape(boxOutline(10, 20, 200, 120));
    expect(r?.type).toBe("rectangle");
    expect(r).toMatchObject({ x: 10, y: 20, width: 200, height: 120 });
  });
  it("recognises an oval, even a wobbly one", () => {
    const r = recognizeShape(
      ring((a) => ({
        x: 100 + Math.cos(a) * (80 + Math.sin(a * 5) * 3),
        y: 50 + Math.sin(a) * 40,
      })),
    );
    expect(r?.type).toBe("ellipse");
  });
  it("recognises a diamond", () => {
    const corners = [
      { x: 100, y: 0 },
      { x: 200, y: 80 },
      { x: 100, y: 160 },
      { x: 0, y: 80 },
    ];
    const pts: Point[] = [];
    for (let c = 0; c < 4; c++) {
      const a = corners[c];
      const b = corners[(c + 1) % 4];
      for (let i = 0; i < 16; i++)
        pts.push({ x: a.x + ((b.x - a.x) * i) / 16, y: a.y + ((b.y - a.y) * i) / 16 });
    }
    pts.push(corners[0]);
    expect(recognizeShape(pts)?.type).toBe("diamond");
  });
  it("leaves open strokes, squiggles and tiny marks unrecognised", () => {
    const line = Array.from({ length: 30 }, (_, i) => ({ x: i * 10, y: i * 3 }));
    expect(recognizeShape(line)).toBeNull();
    const zigzag = Array.from({ length: 40 }, (_, i) => ({ x: i * 6, y: i % 2 ? 0 : 60 }));
    expect(recognizeShape(zigzag)).toBeNull();
    expect(recognizeShape(boxOutline(0, 0, 8, 8))).toBeNull();
    // a star is closed but is none of the shapes
    const star = ring((a) => {
      const r = Math.round((a / (Math.PI * 2)) * 10) % 2 ? 40 : 100;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    }, 10);
    expect(recognizeShape(star)).toBeNull();
  });
});

describe("Pour colour targets (DRAW-19)", () => {
  const box = { ...createShape("rectangle", 0, 0), width: 100, height: 100 };
  const open = createLinear("line", 200, 0, undefined, [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]);
  const els = [box, { ...open, width: 100, height: 100 }];
  it("finds the inside of an unfilled closed shape", () => {
    expect(pourTargetAt(els, { x: 50, y: 50 }, 4)).toMatchObject({
      kind: "fill",
      element: { id: box.id },
    });
  });
  it("reports empty space and open paths", () => {
    expect(pourTargetAt(els, { x: 500, y: 500 }, 4).kind).toBe("none");
    expect(pourTargetAt(els, { x: 250, y: 0 }, 4).kind).toBe("open");
    expect(pourTargetAt(els, { x: 260, y: 50 }, 4).kind).toBe("none");
  });
  it("treats closed paths as fillable and refuses locked shapes", () => {
    const closed = { ...open, closed: true, width: 100, height: 100 };
    expect(pourTargetAt([closed], { x: 280, y: 40 }, 4).kind).toBe("fill");
    expect(pourTargetAt([{ ...box, locked: true }], { x: 50, y: 50 }, 4).kind).toBe("locked");
  });
});

describe("Web card links (DRAW-14)", () => {
  it("embeds YouTube with a privacy-friendly player", () => {
    const r = resolveWebCard("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s");
    expect(r).toMatchObject({
      ok: true,
      target: {
        kind: "embed",
        provider: "YouTube",
        src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=65",
      },
    });
    expect(resolveWebCard("youtu.be/dQw4w9WgXcQ").ok).toBe(true);
  });
  it("embeds Figma files", () => {
    const r = resolveWebCard("https://www.figma.com/file/abc123/My-design");
    expect(r.ok && r.target.kind === "embed" && r.target.src).toContain(
      "https://www.figma.com/embed?embed_host=chalanamaya&url=",
    );
  });
  it("shows other sites as a safe link", () => {
    const r = resolveWebCard("example.com/page");
    expect(r).toMatchObject({
      ok: true,
      target: { kind: "link", url: "https://example.com/page", host: "example.com" },
    });
  });
  it("rejects empty, invalid and unsafe addresses with a message", () => {
    for (const bad of ["", "not a link", "javascript:alert(1)", "ftp://x.org", "file:///etc"]) {
      const r = resolveWebCard(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(5);
    }
  });
  it("round-trips through the file format", () => {
    const el = createEmbed(1, 2, "https://example.com/");
    expect(parseElement(JSON.parse(JSON.stringify(el)))).toEqual(el);
  });
});

describe("Spreadsheet charts (FILE-09)", () => {
  const sheet = "Month\tSales\tCosts\nJan\t10\t4\nFeb\t20\t6\nMar\t15\t9";
  it("detects spreadsheet rows but not ordinary words", () => {
    expect(looksLikeSpreadsheet(sheet)).toBe(true);
    expect(looksLikeSpreadsheet("a,1\nb,2")).toBe(true);
    expect(looksLikeSpreadsheet("hello world")).toBe(false);
    expect(looksLikeSpreadsheet("line one\nline two")).toBe(false);
  });
  it("finds labels, a header and number columns", () => {
    const r = parseSpreadsheet(sheet);
    expect(r).toEqual({
      ok: true,
      data: {
        labels: ["Jan", "Feb", "Mar"],
        series: [
          { name: "Sales", values: [10, 20, 15] },
          { name: "Costs", values: [4, 6, 9] },
        ],
        title: "Month",
      },
    });
    expect(parseSpreadsheet("A\t$1,200\nB\t30%")).toMatchObject({
      ok: true,
      data: { series: [{ values: [1200, 30] }] },
    });
  });
  it("explains empty and invalid data", () => {
    expect(parseSpreadsheet("   ")).toMatchObject({ ok: false });
    const r = parseSpreadsheet("a\tb\nc\td");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/number/i);
    const ok = parseSpreadsheet("a\t1\nb\t2");
    expect(ok.ok && chartKindProblem("radar", ok.data)).toMatch(/at least 3/);
  });
  it("builds grouped, editable items for every chart kind", () => {
    const r = parseSpreadsheet(sheet);
    if (!r.ok) throw new Error("parse failed");
    for (const kind of ["bar", "line", "radar"] as const) {
      const els = buildChart(r.data, kind, { x: 0, y: 0 });
      expect(els.length).toBeGreaterThan(4);
      const groups = new Set(els.map((e) => e.groupIds.join()));
      expect(groups.size).toBe(1);
      expect(els.some((e) => e.type === "text" && e.text === "Feb")).toBe(true);
      for (const e of els) expect(Number.isFinite(e.x + e.y + e.width + e.height)).toBe(true);
    }
    const bars = buildChart(r.data, "bar", { x: 0, y: 0 }).filter(
      (e) => e.type === "rectangle" && e.height > 20,
    );
    expect(bars).toHaveLength(6);
  });
});

describe("Pencil pressure (DRAW-09)", () => {
  it("passes recorded pressure and keeps a steady width without it", () => {
    const base = {
      ...createFreedraw(0, 0),
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    };
    expect(freedrawInput(base)).toEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(freedrawOptions(base)).toMatchObject({ thinning: 0, simulatePressure: false });
    const pressed = { ...base, pressures: [0.2, 0.9] };
    expect(freedrawInput(pressed)).toEqual([
      [0, 0, 0.2],
      [10, 0, 0.9],
    ]);
    expect(freedrawOptions(pressed).thinning).toBeGreaterThan(0);
  });
  it("keeps pressure in saved files and drops broken values", () => {
    const el = {
      ...createFreedraw(0, 0),
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    };
    expect(parseElement({ ...el, pressures: [0.3, 0.6] })).toMatchObject({ pressures: [0.3, 0.6] });
    expect(parseElement({ ...el, pressures: [0.3] })).not.toHaveProperty("pressures");
  });
});

describe("Spotlight trail (DRAW-16)", () => {
  it("fades and drops old points", () => {
    const strokes = [
      {
        points: [
          { x: 0, y: 0, t: 0 },
          { x: 5, y: 5, t: 900 },
        ],
      },
    ];
    expect(pruneSpotlight(strokes, 500)).toBe(strokes);
    expect(pruneSpotlight(strokes, 1500)).toEqual([{ points: [{ x: 5, y: 5, t: 900 }] }]);
    expect(pruneSpotlight(strokes, 5000)).toEqual([]);
    expect(pruneSpotlight(strokes, 5000, undefined, true)).toHaveLength(1);
    expect(spotlightAlpha(0, 0)).toBe(1);
    expect(spotlightAlpha(0, 5000)).toBe(0);
  });
});

describe("Board overview (VIEW-05)", () => {
  const panel = { width: 200, height: 100 };
  const size = { width: 800, height: 600 };
  it("fits artwork and the viewport into the panel", () => {
    const v = { scrollX: 0, scrollY: 0, zoom: 1 };
    const l = minimapLayout({ minX: 1000, minY: 0, maxX: 2000, maxY: 500 }, v, size, panel);
    expect(l.view.x).toBeGreaterThanOrEqual(0);
    expect(l.view.x + l.view.width).toBeLessThanOrEqual(panel.width + 1e-6);
    expect(l.view.y + l.view.height).toBeLessThanOrEqual(panel.height + 1e-6);
    const corner = minimapToBoard(l, { x: l.view.x, y: l.view.y });
    expect(corner.x).toBeCloseTo(0);
    expect(corner.y).toBeCloseTo(0);
  });
  it("handles an empty board", () => {
    const l = minimapLayout(null, { scrollX: 0, scrollY: 0, zoom: 1 }, size, panel);
    expect(Number.isFinite(l.scale)).toBe(true);
    expect(l.view.width).toBeGreaterThan(0);
  });
  it("centres the main view on a picked point", () => {
    const v = centerViewportOn({ scrollX: 0, scrollY: 0, zoom: 2 }, { x: 500, y: 300 }, size);
    // centre of the screen maps back to the board point
    expect(size.width / 2 / v.zoom - v.scrollX).toBeCloseTo(500);
    expect(size.height / 2 / v.zoom - v.scrollY).toBeCloseTo(300);
  });
});
