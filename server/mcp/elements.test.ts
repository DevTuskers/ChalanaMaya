/** Unit: forgiving input conversion, refusals and output shapes. */
import { describe, expect, it } from "vitest";
import { validateStoredElement } from "../../src/shared/validate";
import { buildElement, freeSpace, inputType, place, type BuildContext } from "./elements";
import type { StoredFile } from "../../src/shared/protocol";
import { boardColor, color, colorName, num, ToolError } from "./palette";
import { compactElement, fullElement, outlineLine } from "./view";
import { ELEMENTS_REFERENCE, PALETTE_REFERENCE, guideText } from "./guide";

const ctx = (): BuildContext => ({
  byId: new Map(),
  keys: new Map(),
  files: new Map(),
  warnings: [],
  groups: new Map(),
  cursor: { x: 80, y: 80 },
});

const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ToolError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("did not throw");
};

describe("palette", () => {
  it("accepts names, hex and numeric strings", () => {
    expect(color("Lagoon", "s", "stroke")).toMatch(/^#/);
    expect(color("#ABCDEF", "s", "stroke")).toBe("#abcdef");
    expect(colorName(color("mint", "f", "fill"))).toBe("mint");
    expect(num("12.5", "x")).toBe(12.5);
    expect(boardColor("mist", "b")).toBe("#eef6f4");
    expect(err(() => num("abc", "elements[0].x")).message).toBe("elements[0].x: must be a number");
    expect(err(() => color("plaid", "f", "fill")).message).toMatch(/"plaid" is not a colour.*mint/);
  });
});

describe("buildElement", () => {
  it("builds valid stored elements with forgiving input", () => {
    const c = ctx();
    const b = buildElement(
      {
        type: "rectangle",
        x: "40",
        y: 40,
        width: 200,
        label: "Hi",
        angle: 90,
        opacity: "50",
        roughness: "tidy",
        edges: "round",
      },
      "elements[0]",
      c,
    );
    expect(b.el).toMatchObject({ type: "rectangle", x: 40, width: 200, opacity: 50, roughness: 0 });
    expect(b.el.angle).toBeCloseTo(Math.PI / 2);
    expect(b.label?.text).toBe("Hi");
    expect(validateStoredElement(b.el).ok).toBe(true);
    for (const t of ["ellipse", "diamond", "text", "note", "frame", "line", "freedraw"]) {
      const o: Record<string, unknown> = { type: t };
      if (t === "text") o.text = "t";
      if (t === "line" || t === "freedraw")
        o.points = [
          [0, 0],
          [10, 10],
        ];
      const el = buildElement(o, "e", c).el;
      expect(validateStoredElement(el).ok, t).toBe(true);
    }
  });

  it("places items without x/y into free space", () => {
    const c = ctx();
    const a = place(buildElement({ type: "rectangle" }, "e", c).el, {}, c);
    expect([a.x, a.y]).toEqual([80, 80]);
    const b = place(buildElement({ type: "rectangle" }, "e", c).el, {}, c);
    expect([b.x, b.y]).toEqual([80, 200]);
    expect(freeSpace([a])).toEqual({ x: 320, y: 80 });
  });

  it("builds links, GIFs and videos; refuses later kinds and unknown types precisely", () => {
    const files = new Map<string, StoredFile>();
    const file = (id: string, mime: string, source: "upload" | "remote" = "upload") =>
      files.set(id, {
        id,
        mime,
        url: "",
        size: 1,
        width: 320,
        height: 180,
        durationMs: null,
        source,
        posterFileId: null,
      });
    file("fgif", "image/gif");
    file("fvid", "video/mp4");
    file("fpng", "image/png");
    const c = {
      ...ctx(),
      files,
      addLink: (url: string, mime: string) => {
        file("flink", mime, "remote");
        return { ...files.get("flink")!, url };
      },
    };
    // no linker (pure context): links are refused as invalid input
    expect(
      err(() => buildElement({ type: "image", url: "https://e.com/a.png" }, "elements[2]", ctx())),
    ).toMatchObject({ code: "invalid_input" });
    const link = buildElement({ type: "image", url: "https://E.com/a.png" }, "e[0]", c).el;
    expect(link).toMatchObject({ type: "image", fileId: "flink" });
    expect(
      err(() => buildElement({ type: "image", url: "https://localhost/a.png" }, "e[0]", c)).message,
    ).toMatch(/e\[0\]\.url: the link must not point to this computer/);
    expect(
      err(() => buildElement({ type: "video", url: "https://e.com/page" }, "e[0]", c)).message,
    ).toMatch(/mime_type/);
    const gif = buildElement({ type: "gif", file_id: "fgif", paused: true }, "e[0]", c).el;
    expect(gif).toMatchObject({ type: "image", fileId: "fgif", paused: true });
    const vid = buildElement({ type: "video", file_id: "fvid" }, "e[0]", c).el;
    expect(vid).toMatchObject({ type: "image", fileId: "fvid", loop: true, autoplay: true });
    expect(vid.height / vid.width).toBeCloseTo(180 / 320);
    expect(inputType(vid, files)).toBe("video");
    expect(inputType(gif, files)).toBe("gif");
    expect(err(() => buildElement({ type: "gif", file_id: "fpng" }, "e[0]", c)).message).toMatch(
      /not a gif/,
    );
    expect(err(() => buildElement({ type: "image", file_id: "fvid" }, "e[0]", c)).message).toMatch(
      /use type "video"/,
    );
    expect(
      err(() => buildElement({ type: "image", file_id: "fpng", loop: true }, "e[0]", c)).message,
    ).toMatch(/only videos/);
    expect(err(() => buildElement({ type: "component" }, "elements[0]", ctx())).message).toMatch(
      /^elements\[0\]\.preset: is required/,
    );
    expect(err(() => buildElement({ type: "hexagon" }, "elements[3]", ctx())).message).toMatch(
      /^elements\[3\]\.type: must be one of/,
    );
    expect(
      err(() => buildElement({ type: "rectangle", x: 2e6 }, "elements[0]", ctx())).message,
    ).toMatch(/elements\[0\]\.x: must be at most 1000000/);
  });

  it("warns on unknown fields instead of failing", () => {
    const c = ctx();
    buildElement({ type: "note", colour: "butter" }, "elements[1]", c);
    expect(c.warnings).toEqual(["elements[1].colour: unknown field, ignored"]);
  });
});

describe("output", () => {
  it("compact, full and outline views use input names", () => {
    const c = ctx();
    const b = buildElement({ type: "rectangle", x: 0, y: 0, label: "A", fill: "peach" }, "e", c);
    const compact = compactElement(b.el, b.label, new Map());
    expect(compact).toMatchObject({ type: "rectangle", x: 0, y: 0, label: "A", fill: "peach" });
    const full = fullElement(b.el, b.label);
    expect(full).toMatchObject({ id: b.el.id, angle: 0, fill: color("peach", "f", "fill") });
    expect(outlineLine(b.el, b.label)).toMatch(/^box \S+ "A" at \(0,0\) 160×80 peach$/);
  });
});

describe("guide", () => {
  it("serves the skill and references", () => {
    expect(guideText()).toMatch(/^---\nname: chalanamaya/);
    expect(ELEMENTS_REFERENCE.types).toContain("component");
    expect(ELEMENTS_REFERENCE.per_type.component.preset).toMatch(/spinner/);
    expect(ELEMENTS_REFERENCE.types).toContain("video");
    expect(Object.keys(PALETTE_REFERENCE.fill)).toContain("mint");
  });
});
