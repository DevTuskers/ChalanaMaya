import { describe, expect, it } from "vitest";
import { createShape, createText } from "../scene/elements";
import {
  EmbedError,
  embedInPng,
  extractFromPng,
  extractFromSvg,
  isPng,
  svgMetadata,
} from "./embed";
import { elementsToPlainText, exportToSvg } from "./svg";

// 1x1 transparent PNG
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

describe("embedded board data", () => {
  it("round-trips through a PNG and keeps it a valid PNG", () => {
    const json = JSON.stringify({ type: "chalanamaya", text: "नमस्ते ✓" });
    const out = embedInPng(PNG, json);
    expect(isPng(out)).toBe(true);
    expect(out.length).toBeGreaterThan(PNG.length);
    expect(extractFromPng(out)).toBe(json);
    expect(extractFromPng(PNG)).toBeNull();
  });

  it("detects damaged PNG data", () => {
    const out = embedInPng(PNG, '{"a":1}');
    const text = new TextDecoder("latin1").decode(out);
    const at = text.indexOf("chalanamaya") + 13;
    const bad = out.slice();
    bad[at] = bad[at] ^ 0xff;
    expect(() => extractFromPng(bad)).toThrow(EmbedError);
  });

  it("round-trips through SVG metadata and refuses damaged data", () => {
    const json = '{"x":"<&>"}';
    expect(extractFromSvg(`<svg>${svgMetadata(json)}</svg>`)).toBe(json);
    expect(extractFromSvg("<svg></svg>")).toBeNull();
    expect(() =>
      extractFromSvg('<svg><metadata id="chalanamaya-scene">%%%</metadata></svg>'),
    ).toThrow(EmbedError);
  });
});

describe("SVG export", () => {
  it("builds standalone SVG with the board colour and escaped text", () => {
    const shape = createShape("rectangle", 0, 0, undefined, 100, 60);
    const text = { ...createText(0, 100, undefined, "a < b"), width: 40, height: 24 };
    const svg = exportToSvg([shape, text], {}, { theme: "dark", background: "#172524" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('fill="#172524"');
    expect(svg).toContain("a &lt; b");
    expect(() => exportToSvg([], {}, { theme: "light", background: null })).toThrow();
  });

  it("copies plain text in reading order", () => {
    const a = createText(0, 100, undefined, "second");
    const b = createText(0, 0, undefined, "first");
    expect(elementsToPlainText([a, b, createShape("rectangle", 0, 0)])).toBe("first\n\nsecond");
  });
});

describe("expanded board model", () => {
  it("fills P1 defaults for older items and keeps P1 fields", async () => {
    const { parseElement } = await import("./serialize");
    const old = {
      id: "a",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      angle: 0,
      strokeColor: "#000",
      backgroundColor: "transparent",
      fillStyle: "hachure",
      strokeWidth: 2,
      seed: 1,
      locked: false,
    };
    expect(parseElement(old)).toMatchObject({
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      link: null,
    });
    const rich = parseElement({ ...old, strokeStyle: "dotted", opacity: 30, link: "https://a.b/" });
    expect(rich).toMatchObject({ strokeStyle: "dotted", opacity: 30, link: "https://a.b/" });
    // unsafe links never survive opening a file
    expect(parseElement({ ...old, link: "javascript:alert(1)" }).link).toBeNull();
  });
});
