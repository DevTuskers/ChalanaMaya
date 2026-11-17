// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createFrame, createFreedraw, createShape, createText } from "../scene/elements";
import type { SceneElement } from "../scene/types";
import { attr, exportToSvg } from "./svg";

const rect = () => createShape("rectangle", 10, 20);

it("attr() escapes quotes, angle brackets and ampersands", () => {
  expect(attr(`a"b'c<d>e&f`)).toBe("a&quot;b&#39;c&lt;d&gt;e&amp;f");
});

describe("SVG export escapes every attribute", () => {
  it("has no script and parses as XML even with hostile markup", () => {
    const hostile = '"/><script>alert(1)</script><x a="';
    const els = [
      { ...rect(), strokeColor: hostile, backgroundColor: hostile, fillStyle: "solid" },
      { ...createText(0, 0, undefined, "<script>alert(2)</script>"), strokeColor: hostile },
      {
        ...createFreedraw(0, 0),
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        strokeColor: hostile,
      },
      {
        ...createFrame(0, 0),
        name: "</text><script>3</script>",
        strokeColor: hostile,
        width: 50,
        height: 50,
      },
    ] as SceneElement[];
    const svg = exportToSvg(els, {}, { background: hostile, theme: "light", padding: 10 });
    expect(svg.toLowerCase()).not.toContain("<script");
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
    expect(doc.getElementsByTagName("script").length).toBe(0);
  });
});
