import { describe, expect, it } from "vitest";
import { parseBoard, serializeBoard } from "../io/serialize";
import {
  createEmbed,
  createFrame,
  createFreedraw,
  createImage,
  createLinear,
  createNote,
  createShape,
  createText,
} from "../scene/elements";
import { captureInteraction, interactionScene, rebaseElements } from "../scene/rebase";
import { RemoteLog } from "../sync/remoteLog";
import { getCommonBounds } from "../scene/geometry";
import { finalizeScene } from "../scene/scene";
import { resizeElement, resizeGroup } from "../scene/transform";
import type { FreedrawElement, LinearElement, SceneElement, TextElement } from "../scene/types";
import { setTool } from "../store/actions";
import { Store, initialState, type ToolId } from "../store/store";
import { Controller, type PointerInput } from "../tools/controller";
import { injectionCorpus } from "./corpus";
import { canonicalizeElements, splitFreedraw, summarizeReport } from "./canonical";
import { MAX_KEY_LENGTH, assignKeys, isValidKey, orderByKey } from "./keys";
import { LIMITS, freedrawSourcePoints, wrapAngle } from "./limits";
import { validateFileMeta, validateSettings, validateStoredElement } from "./validate";

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

const ok = (el: unknown) => {
  const before = JSON.stringify(el);
  const r = validateStoredElement(el);
  if (!r.ok) throw new Error(`${r.path}: ${r.reason}`);
  // strict validation never changes what it checks
  expect(JSON.stringify(r.el)).toBe(before);
  expect(r.el).toBe(el);
};

const rect = () => createShape("rectangle", 10, 20);

describe("strict validation", () => {
  it("rejects the injection corpus with a field path", () => {
    const corpus = injectionCorpus();
    expect(corpus.length).toBeGreaterThan(20);
    for (const [el, path] of corpus) {
      const r = validateStoredElement(el);
      expect(r.ok, path).toBe(false);
      if (!r.ok) expect(r.path).toBe(path);
    }
  });

  it("rejects oversized strokes and bad pressures", () => {
    const fd = createFreedraw(0, 0);
    const pts = Array.from({ length: LIMITS.freedrawPoints + 1 }, (_, i) => ({ x: i, y: 0 }));
    expect(validateStoredElement({ ...fd, points: pts }).ok).toBe(false);
    const r = validateStoredElement({ ...fd, points: [{ x: 0, y: 0 }], pressures: [2] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.path).toBe("pressures[0]");
  });

  it("checks settings and file rows", () => {
    expect(validateSettings({ viewBackgroundColor: "#fff9ed", gridEnabled: true }).ok).toBe(true);
    expect(validateSettings({ theme: "dark" }).ok).toBe(false);
    expect(validateSettings({ title: "a\u0007b" }).ok).toBe(false);
    const sid = "a".repeat(24);
    expect(
      validateFileMeta({ id: "f1", mime: "image/png", url: `/api/sessions/${sid}/files/f1` }).ok,
    ).toBe(true);
    expect(
      validateFileMeta({ id: "f1", mime: "image/svg+xml", url: `/api/sessions/${sid}/files/f1` })
        .ok,
    ).toBe(false);
    expect(
      validateFileMeta({ id: "f1", mime: "image/png", url: "https://evil.test/x.png" }).ok,
    ).toBe(false);
  });
});

describe("every tool's output passes validation unchanged", () => {
  it("factories", () => {
    const els: SceneElement[] = [
      createShape("rectangle", 0, 0),
      createShape("diamond", 0, 0),
      createShape("ellipse", 0, 0),
      createLinear("arrow", 0, 0),
      createLinear("line", 0, 0),
      createFreedraw(0, 0),
      createText(0, 0, undefined, "hello"),
      createNote(0, 0),
      createFrame(0, 0),
      createEmbed(0, 0, "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      createImage(0, 0, 10, 10, "file1"),
    ];
    for (const el of els) ok(el);
  });

  it("drawing with each tool, then moving, resizing and rotating", () => {
    const store = new Store(initialState());
    const controller = new Controller(store);
    const tools: ToolId[] = [
      "rectangle",
      "diamond",
      "ellipse",
      "arrow",
      "line",
      "freedraw",
      "frame",
      "note",
    ];
    tools.forEach((tool, i) => {
      setTool(store, tool);
      const y = i * 300;
      controller.pointerDown(input(0, y));
      controller.pointerMove(input(60, y + 40));
      controller.pointerMove(input(120, y + 80));
      controller.pointerUp(input(120, y + 80));
    });
    setTool(store, "pick");
    for (let turn = 0; turn < 40; turn++) {
      const el = store.get().elements[0];
      store.set({ selectedIds: new Set([el.id]) });
      const rotated = store
        .get()
        .elements.map((e) => (e.id === el.id ? { ...e, angle: wrapAngle(e.angle + 1.3) } : e));
      store.commit(rotated);
    }
    expect(store.get().elements.length).toBeGreaterThanOrEqual(tools.length);
    for (const el of store.get().elements) ok(el);

    // text resized far up stays at a valid font size
    const t = createText(0, 0, undefined, "grow me");
    ok(t);
    for (const handle of ["se", "nw", "e"] as const) {
      const big = resizeElement(t, handle, { x: t.width * 500, y: t.height * 500 }, false);
      ok(big);
      if (big.type === "text") expect(big.fontSize).toBeLessThanOrEqual(LIMITS.fontSizeMax);
    }
    let grown: SceneElement = t;
    for (let i = 0; i < 6; i++)
      grown = resizeElement(grown, "se", { x: grown.x + grown.width * 9, y: 0 }, false);
    ok(grown);
    expect((grown as TextElement).fontSize).toBe(LIMITS.fontSizeMax);

    // a group shrunk far down (and grown far up) keeps every text valid
    let group: SceneElement[] = [
      createText(0, 0, undefined, "tiny"),
      { ...createShape("rectangle", 0, 40), width: 100, height: 60 },
    ];
    const all = new Set(group.map((e) => e.id));
    for (let i = 0; i < 3; i++) {
      const b = getCommonBounds(group)!;
      group = resizeGroup(group, all, b, "se", { x: b.minX + 0.001, y: b.minY + 0.001 });
      for (const el of group) ok(el);
    }
    expect((group[0] as TextElement).fontSize).toBeGreaterThanOrEqual(LIMITS.fontSizeMin);
    for (let i = 0; i < 4; i++) {
      const b = getCommonBounds(group)!;
      group = resizeGroup(group, all, b, "se", { x: b.maxX * 100, y: b.maxY * 100 });
      for (const el of group) ok(el);
    }
    expect((group[0] as TextElement).fontSize).toBeLessThanOrEqual(LIMITS.fontSizeMax);
  });

  it("text and frame names are capped at the source", () => {
    const store = new Store(initialState());
    const controller = new Controller(store);
    const t = createText(0, 0);
    store.commit([t]);
    controller.updateText(t.id, "x".repeat(LIMITS.textChars + 50));
    const text = store.get().elements[0] as TextElement;
    expect(text.text.length).toBe(LIMITS.textChars);
    ok(text);
  });

  it("a very long pencil stroke becomes several valid strokes", () => {
    const store = new Store(initialState());
    const controller = new Controller(store);
    setTool(store, "freedraw");
    controller.pointerDown(input(0, 0));
    for (let i = 1; i <= LIMITS.freedrawPoints + 200; i++)
      controller.pointerMove(input(i * 2, (i % 7) * 3));
    controller.pointerUp(input(0, 0));
    const strokes = store.get().elements.filter((e): e is FreedrawElement => e.type === "freedraw");
    expect(strokes.length).toBe(2);
    for (const s of strokes) {
      expect(s.points.length).toBeLessThanOrEqual(LIMITS.freedrawPoints);
      ok(s);
    }
  });

  const drawLong = (pen: boolean, zoom: number, count: number) => {
    const store = new Store(initialState());
    store.set({ viewport: { scrollX: 13.37, scrollY: -7.77, zoom } });
    const controller = new Controller(store);
    setTool(store, "freedraw");
    const extra = (i: number): Partial<PointerInput> =>
      pen ? { pointerType: "pen", pressure: 0.1 + ((i * 37) % 89) / 100 } : {};
    controller.pointerDown(input(0.3, 0.7, extra(0)));
    for (let i = 1; i <= count; i++)
      controller.pointerMove(input(i * 0.913 + 0.1234567, ((i * 13) % 97) * 1.789, extra(i)));
    controller.pointerUp(input(count * 0.913, 1, extra(count)));
    return store.get().elements.filter((e): e is FreedrawElement => e.type === "freedraw");
  };

  it("long strokes with pen pressure and fractional zoom stay under the byte cap", () => {
    for (const [pen, zoom] of [
      [true, 1.37],
      [true, 0.3],
      [false, 1.37],
    ] as const) {
      const strokes = drawLong(pen, zoom, 7000);
      expect(strokes.length).toBeGreaterThan(1);
      for (const s of strokes) {
        expect(s.points.length).toBeLessThanOrEqual(freedrawSourcePoints(!!s.pressures));
        if (pen) expect(s.pressures?.length).toBe(s.points.length);
        ok(s);
        // still valid after a big fractional resize
        const r = resizeElement(
          s,
          "se",
          { x: s.x + s.width * 3.1415, y: s.y + s.height * 2.71 },
          false,
        );
        ok(r);
      }
    }
  });

  it("the source caps fit the byte cap in the worst case", () => {
    const worst = -0.0000012345678901234567; // longest JSON number in range
    expect(JSON.stringify(worst)).toHaveLength(25);
    const gid = "g".repeat(64);
    for (const pressured of [false, true]) {
      const n = freedrawSourcePoints(pressured);
      const el = {
        ...createFreedraw(worst, worst),
        id: "i".repeat(64),
        width: 9_999_999.123456789,
        height: 9_999_999.123456789,
        angle: Math.PI / 7,
        groupIds: Array.from({ length: LIMITS.groupIds }, (_, i) =>
          `${gid.slice(0, 62)}${i}`.slice(0, 64),
        ),
        frameId: "f".repeat(64),
        link: `https://example.com/${"a".repeat(LIMITS.link - 20)}`,
        points: Array.from({ length: n }, () => ({ x: worst, y: worst })),
        ...(pressured
          ? { pressures: Array.from({ length: n }, () => 0.0000012345678901234567) }
          : {}),
      } as FreedrawElement;
      ok(el);
    }
  });

  it("wrapAngle stays in [0, 2π)", () => {
    for (const a of [-0, -1, 0, 7, 100, -100, Math.PI * 2, Math.PI * 4 - 1e-15]) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(Math.PI * 2);
    }
  });
});

describe("canonicalisation at the file edge", () => {
  it("tidies legacy values, remaps bad ids and validates the result", () => {
    const box = { ...rect(), id: "bad id!", strokeColor: "#ABCDEF", angle: 9 } as SceneElement;
    const label = {
      ...createText(0, 0, undefined, "x".repeat(LIMITS.textChars + 5)),
      containerId: "bad id!",
    };
    const evil = { ...rect(), strokeColor: '"/><script>alert(1)</script>' } as SceneElement;
    const { elements, report } = canonicalizeElements([box, label as SceneElement, evil]);
    expect(elements).toHaveLength(3);
    for (const el of elements) ok(el);
    const [b, l, e] = elements as [SceneElement, TextElement, SceneElement];
    expect(b.id).not.toBe("bad id!");
    expect(l.containerId).toBe(b.id);
    expect(l.text.length).toBe(LIMITS.textChars);
    expect(b.strokeColor).toBe("#abcdef");
    expect(b.angle).toBeCloseTo(9 - Math.PI * 2);
    expect(e.strokeColor).toBe("#193a36");
    expect(report.changes.length).toBeGreaterThan(3);
  });

  it("splits oversized freedraw paths", () => {
    const fd = createFreedraw(5, 5);
    const pts = Array.from({ length: 12_001 }, (_, i) => ({ x: i, y: i % 3 }));
    const parts = splitFreedraw({ ...fd, points: pts, width: 12_000, height: 2 });
    expect(parts.length).toBe(3);
    for (const p of parts) {
      expect(p.points.length).toBeLessThanOrEqual(LIMITS.freedrawPoints);
      ok(p);
    }
    expect(new Set(parts.map((p) => p.id)).size).toBe(3);
  });

  it("splits a 5,000-point stroke with pressures that is over the byte cap, losing nothing", () => {
    const n = LIMITS.freedrawPoints;
    const points = Array.from({ length: n }, (_, i) => ({
      x: i * 1.234567890123 + 0.1,
      y: ((i * 7) % 101) * 3.3333333333333335,
    }));
    const pressures = Array.from({ length: n }, (_, i) => 0.05 + ((i * 31) % 95) / 100.3);
    const fd = { ...createFreedraw(10.5, 20.25), points, pressures, width: 6200, height: 340 };
    expect(validateStoredElement(fd)).toMatchObject({ ok: false, reason: "element_too_large" });
    const { elements, report } = canonicalizeElements([fd]);
    expect(report.dropped).toEqual([]);
    expect(elements.length).toBeGreaterThan(1);
    for (const el of elements) ok(el);
    // consecutive parts share their joining point
    const total = elements.reduce((sum, el) => sum + (el as FreedrawElement).points.length, 0);
    expect(total - (elements.length - 1)).toBe(n);
    const first = elements[0] as FreedrawElement;
    expect(first.x + first.points[0].x).toBeCloseTo(fd.x + points[0].x);
    // an in-limit stroke is left alone
    const small = { ...fd, points: points.slice(0, 100), pressures: pressures.slice(0, 100) };
    const kept = canonicalizeElements([small]);
    expect(kept.elements).toHaveLength(1);
    expect(kept.elements[0].id).toBe(fd.id);
  });

  it("gives every copy of a duplicated invalid id its own new id", () => {
    const a = { ...rect(), id: "bad id" } as SceneElement;
    const b = { ...rect(), id: "bad id" } as SceneElement;
    const c = { ...rect(), id: "good" } as SceneElement;
    const d = { ...rect(), id: "good" } as SceneElement;
    const label = { ...createText(0, 0, undefined, "x"), containerId: "bad id" } as SceneElement;
    const { elements, report } = canonicalizeElements([a, b, c, d, label]);
    expect(report.dropped).toEqual([]);
    expect(elements).toHaveLength(5);
    const ids = elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids[2]).toBe("good");
    expect((elements[4] as TextElement).containerId).toBe(ids[0]);
    for (const el of elements) ok(el);
  });

  it("is self-sufficient: clamps, defaults and reports without parseElement", () => {
    const fd = {
      ...createFreedraw(0, 0),
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
      ],
      pressures: [0.5, 1.5],
    } as FreedrawElement;
    const box = {
      ...rect(),
      opacity: 300,
      x: Number.NaN,
      y: 1e12,
      strokeWidth: -3,
      seed: 12.7,
      fillStyle: "plaid",
      roughness: 7,
      locked: "yes",
    } as unknown as SceneElement;
    const text = { ...createText(0, 0, undefined, "hi"), fontSize: 5000, fontFamily: "comic" };
    const arrow = { ...createLinear("arrow", 0, 0), routing: "zigzag", endArrowhead: "boom" };
    const { elements, report } = canonicalizeElements([
      fd,
      box,
      text as unknown as SceneElement,
      arrow as unknown as SceneElement,
    ]);
    expect(report.dropped).toEqual([]);
    for (const el of elements) ok(el);
    const [f, b, t, a] = elements as [FreedrawElement, SceneElement, TextElement, LinearElement];
    expect(f.pressures).toEqual([0.5, 1]);
    expect(b.opacity).toBe(100);
    expect(b.x).toBe(0); // non-finite gets the default, not the minimum
    expect(b.y).toBe(LIMITS.coord);
    expect(b.strokeWidth).toBe(0);
    expect(b.seed).toBe(12);
    expect(b.fillStyle).toBe("hachure");
    expect(b.roughness).toBe(1);
    expect(b.locked).toBe(false);
    expect(t.fontSize).toBe(LIMITS.fontSizeMax);
    expect(t.fontFamily).toBe("hand");
    expect(a.routing).toBe("straight");
    expect(a.endArrowhead).toBe("arrow");
    for (const k of ["opacity", "x", "y", "strokeWidth", "seed", "fontSize"])
      expect(report.changes.some((c) => c.includes(`${k} set to`))).toBe(true);
    expect(report.counts["pressure fixed"]).toBe(1);
    expect(report.counts["number fixed"]).toBeGreaterThanOrEqual(6);
  });

  it("never rewrites an image file id, even if it equals a replaced element id", () => {
    const shape = { ...rect(), id: "bad id" } as SceneElement;
    const img = createImage(0, 0, 10, 10, "file1");
    const clash = { ...rect(), id: "file1" } as SceneElement;
    const { elements } = canonicalizeElements([shape, clash, clash, img]);
    const out = elements.find((e) => e.type === "image");
    expect(out && out.type === "image" && out.fileId).toBe("file1");
  });

  it("summarises what changed for the toast", () => {
    const evil = [
      { ...rect(), strokeColor: "red" },
      { ...rect(), backgroundColor: "url(x)" },
      { ...rect(), strokeColor: "#ABCDEF" },
      { ...createEmbed(0, 0, "https://example.com"), url: "javascript:alert(1)" },
    ] as SceneElement[];
    const { report } = canonicalizeElements(evil);
    const text = summarizeReport(report);
    expect(text).toContain("2 colours were reset");
    expect(text).toContain("1 colour was tidied");
    expect(text).toMatch(/1 unreadable item was skipped: embed \S+ \(url\)/);
    expect(summarizeReport(canonicalizeElements([rect()]).report)).toBe("");
  });

  it("parseElement replaces an invalid colour with the default", () => {
    const raw = JSON.parse(
      serializeBoard(
        [rect()],
        {},
        { viewBackgroundColor: "#fff9ed", theme: "light", gridEnabled: false },
      ),
    );
    raw.elements[0].strokeColor = "</svg><script>alert(1)</script>";
    raw.elements[0].backgroundColor = "#ABCDEF";
    const [el] = parseBoard(JSON.stringify(raw)).elements;
    expect(el.strokeColor).toBe("#193a36");
    expect(el.backgroundColor).toBe("#ABCDEF"); // case is canonicalisation's job, and reported
  });

  it("an opened file with hostile values round-trips into valid elements", () => {
    const raw = JSON.parse(
      serializeBoard(
        [rect()],
        {},
        { viewBackgroundColor: "#fff9ed", theme: "light", gridEnabled: false },
      ),
    );
    raw.elements[0].strokeColor = "</svg><script>alert(1)</script>";
    const parsed = parseBoard(JSON.stringify(raw));
    const { elements } = canonicalizeElements(parsed.elements);
    for (const el of elements) ok(el);
  });
});

describe("Rule A: finalizeScene keeps identity", () => {
  const scene = () => {
    const a = { ...createShape("rectangle", 0, 0), width: 100, height: 60 };
    const b = { ...createShape("ellipse", 300, 0), width: 100, height: 60 };
    const label = {
      ...createText(0, 0, undefined, "a label that wraps around"),
      containerId: a.id,
      autoWidth: false,
    };
    const arrow: LinearElement = {
      ...createLinear("arrow", 100, 30),
      points: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ],
      width: 200,
      startBinding: { elementId: a.id },
      endBinding: { elementId: b.id },
    };
    const arrowLabel = { ...createText(0, 0, undefined, "goes"), containerId: arrow.id };
    return [a, b, label as SceneElement, arrow, arrowLabel as SceneElement];
  };

  it("finalizeScene(finalizeScene(s)) returns the same array and objects", () => {
    const once = finalizeScene(scene());
    const twice = finalizeScene(once);
    expect(twice).toBe(once);
    once.forEach((el, i) => expect(twice[i]).toBe(el));
  });

  it("is idempotent by identity for every connector routing", () => {
    for (const type of ["arrow", "line"] as const)
      for (const routing of ["straight", "curved", "elbow"] as const) {
        const a = { ...createShape("rectangle", 0, 0), width: 100, height: 60, angle: 0.7 };
        const b = { ...createShape("diamond", 300, 200), width: 100, height: 60 };
        const c: LinearElement = {
          ...createLinear(type, 100, 30),
          points: [
            { x: 0, y: 0 },
            { x: 120, y: 40 },
            { x: 200, y: 170 },
          ],
          width: 200,
          height: 170,
          routing,
          startBinding: { elementId: a.id },
          endBinding: { elementId: b.id },
        };
        const label = { ...createText(0, 0, undefined, routing), containerId: c.id };
        const once = finalizeScene([a, b, c, label as SceneElement]);
        const twice = finalizeScene(once);
        expect(twice).toBe(once);
        once.forEach((el, i) => expect(twice[i]).toBe(el));
        for (const el of once) ok(el);
      }
  });

  it("touched only recomputes direct dependents", () => {
    const s = finalizeScene(scene());
    const [a, b, , arrow] = s;
    const far = { ...createShape("rectangle", 2000, 2000) };
    const withFar = [...s, far];
    const moved = withFar.map((e) => (e.id === b.id ? { ...e, x: e.x + 50 } : e));
    const out = finalizeScene(moved, [b.id]);
    expect(out[0]).toBe(a);
    expect(out[2]).toBe(s[2]);
    expect(out[3]).not.toBe(arrow);
    expect(out[4]).not.toBe(s[4]); // connector label follows its connector
    expect(out[5]).toBe(far);
    expect(finalizeScene(out, [b.id])).toBe(out);
  });
});

describe("Rule C: by-id gestures and rebasing", () => {
  it("a gesture keeps a remote edit to another element", () => {
    const a = createShape("rectangle", 0, 0);
    const b = createShape("rectangle", 500, 0);
    const base = captureInteraction([a, b], [a.id]);
    const remoteB = { ...b, strokeColor: "#ff0000" };
    const live = [a, remoteB];
    const scene = interactionScene(live, base);
    expect(scene[1]).toBe(remoteB);
    expect(scene[0]).toBe(a);
  });

  it("a drag computed by id keeps a remote edit that lands mid-gesture", () => {
    const store = new Store(initialState());
    const controller = new Controller(store);
    const solid = { backgroundColor: "#ffffff", fillStyle: "solid" } as const;
    const a = { ...createShape("rectangle", 0, 0), ...solid, width: 100, height: 100 };
    const b = { ...createShape("rectangle", 300, 0), ...solid, width: 100, height: 100 };
    store.commit([a, b]);
    controller.pointerDown(input(50, 50));
    controller.pointerMove(input(60, 60));
    // a remote change arrives mid-gesture: b is recoloured
    store.set({
      elements: store
        .get()
        .elements.map((e) => (e.id === b.id ? { ...e, strokeColor: "#ff0000" } : e)),
    });
    controller.pointerMove(input(80, 80));
    controller.pointerUp(input(80, 80));
    const [ma, mb] = store.get().elements;
    expect(ma.x).toBe(30);
    expect(mb.strokeColor).toBe("#ff0000");
  });

  it("rebaseElements reapplies local edits on a newer remote scene", () => {
    const a = createShape("rectangle", 0, 0);
    const b = createShape("rectangle", 10, 0);
    const c = createShape("rectangle", 20, 0);
    const base = [a, b, c];
    const n = createShape("ellipse", 0, 0);
    const local = [{ ...a, x: 99 }, c, n]; // moved a, deleted b, added n
    const remoteC = { ...c, strokeColor: "#00ff00" };
    const remote = [a, b, remoteC];
    const out = rebaseElements(base, local, remote);
    expect(out.map((e) => e.id)).toEqual([a.id, c.id, n.id]);
    expect(out[0].x).toBe(99);
    expect(out[1]).toBe(remoteC);
    expect(rebaseElements(base, base, remote)).toBe(remote);
  });

  it("RemoteLog brings an undo snapshot forward lazily", () => {
    const log = new RemoteLog();
    const a = createShape("rectangle", 0, 0);
    const b = createShape("rectangle", 10, 0);
    const snapshot = [a, b];
    const at = log.head;
    const b2 = { ...b, x: 77 };
    const c = createShape("diamond", 0, 0);
    log.append({ upserts: [b2], deletes: [] });
    log.append({ upserts: [c], deletes: [a.id] });
    const out = log.rebase(snapshot, at);
    expect(out).toEqual([b2, c]);
    expect(out[0]).toBe(b2);
    expect(log.rebase(snapshot, log.head)).toBe(snapshot);
  });
});

describe("Rule E: layer keys", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}` }));
  const isIncreasing = (order: { id: string }[], keys: Map<string, string>) =>
    order.every((e, i) => i === 0 || keys.get(order[i - 1].id)! < keys.get(e.id)!);

  it("only moved elements get new keys", () => {
    const prev = ids(6);
    const keys = assignKeys([], prev, new Map());
    expect(isIncreasing(prev, keys)).toBe(true);
    const front = [...prev.filter((e) => e.id !== "e1"), prev[1]];
    const next = assignKeys(prev, front, keys, { kind: "front", ids: ["e1"] });
    expect(isIncreasing(front, next)).toBe(true);
    for (const e of front) if (e.id !== "e1") expect(next.get(e.id)).toBe(keys.get(e.id));
    const back = [prev[4], ...prev.filter((e) => e.id !== "e4")];
    const nb = assignKeys(prev, back, keys, { kind: "back", ids: ["e4"] });
    expect(isIncreasing(back, nb)).toBe(true);
    expect([...nb].filter(([id, k]) => keys.get(id) !== k).map(([id]) => id)).toEqual(["e4"]);
  });

  it("repairs duplicate keys and keeps order for random reorders", () => {
    let order = ids(20);
    let keys = assignKeys([], order, new Map());
    const dup = new Map(keys);
    dup.set("e5", keys.get("e4")!);
    const repaired = assignKeys(order, order, dup);
    expect(isIncreasing(order, repaired)).toBe(true);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let step = 0; step < 300; step++) {
      const from = Math.floor(rnd() * order.length);
      const to = Math.floor(rnd() * order.length);
      const next = [...order];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      const nk = assignKeys(order, next, keys, { kind: "move", ids: [moved.id] });
      expect(isIncreasing(next, nk)).toBe(true);
      expect(orderByKey(next, nk).map((e) => e.id)).toEqual(next.map((e) => e.id));
      order = next;
      keys = nk;
    }
  });

  it("treats malformed stored keys as missing instead of throwing", () => {
    const order = ids(5);
    const keys = assignKeys([], order, new Map());
    for (const bad of ["", "a", "zz", "b0", "a0 ", "a00", "<script>", "A0"]) {
      expect(isValidKey(bad)).toBe(false);
      const broken = new Map(keys);
      broken.set("e2", bad);
      const fixed = assignKeys(order, order, broken);
      expect(isIncreasing(order, fixed)).toBe(true);
      expect(fixed.get("e2")).not.toBe(bad);
      for (const k of fixed.values()) expect(isValidKey(k)).toBe(true);
    }
    for (const k of keys.values()) expect(isValidKey(k)).toBe(true);
  });

  it("re-spreads keys that grew too long", () => {
    const order = ids(3);
    let keys = assignKeys([], order, new Map());
    for (let i = 0; i < 200; i++) {
      const next = [order[0], order[2], order[1]];
      keys = assignKeys(order, next, keys, { kind: "forward", ids: [order[2].id] });
      order.splice(0, 3, ...next);
    }
    for (const k of keys.values()) expect(k.length).toBeLessThanOrEqual(MAX_KEY_LENGTH + 2);
    expect(isIncreasing(order, keys)).toBe(true);
  });
});
