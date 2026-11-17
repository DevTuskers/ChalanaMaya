// @vitest-environment jsdom
/** Animated components: presets, the content check, the sanitiser and the srcdoc shell (plan §6.3). */
import DOMPurify from "dompurify";
import { describe, expect, it } from "vitest";
import { buildComponentDoc, COMPONENT_CSP, filterCss, sanitizeHtml } from "./componentDoc";
import {
  checkComponentSource,
  checkCustomContent,
  checkPresetParams,
  COMPONENT_LIMITS,
  PRESETS,
  PRESET_NAMES,
  renderPreset,
} from "../shared/components";
import { validateStoredElement } from "../shared/validate";
import { createComponent } from "../scene/elements";
import { parseBoard, serializeBoard } from "../io/serialize";
import { componentCardSvg } from "../render/componentCard";

const purify = DOMPurify;
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

/** The attack corpus: each must be refused by the check and defused by the sanitiser/filter. */
const HTML_ATTACKS = [
  "<script>parent.alert(1)</script>",
  '<img src="x" onerror="alert(1)">',
  '<div onclick="alert(1)">x</div>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="https://evil.example/">x</a>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
  '<iframe src="https://evil.example/"></iframe>',
  '<object data="x.swf"></object>',
  '<embed src="x.swf">',
  '<form action="https://evil.example/"><button>go</button></form>',
  '<link rel="stylesheet" href="https://evil.example/a.css">',
  '<base href="https://evil.example/">',
  "<style>body{background:url(https://evil.example/t.png)}</style>",
  '<svg><foreignObject><body onload="alert(1)"></body></foreignObject></svg>',
  '<img src="https://evil.example/track.png">',
  '<div style="background:url(https://evil.example/t.png)">x</div>',
];
const CSS_ATTACKS = [
  '@import url("https://evil.example/a.css");',
  "body{background:url(https://evil.example/t.png)}",
  "body{background:u\\72l(https://evil.example/t.png)}",
  "div{width:expression(alert(1))}",
  "div{behavior:url(x.htc)}",
  "div{-moz-binding:url(x.xml#x)}",
  "</style><script>alert(1)</script>",
  "div{background:image-set('https://evil.example/a.png' 1x)}",
  '@font-face{font-family:x;src:url("https://evil.example/f.woff")}',
];

describe("custom component content check", () => {
  it("refuses every attack with a named rule", () => {
    for (const h of HTML_ATTACKS) {
      const bad = checkCustomContent(h, "");
      expect(bad, h).not.toBeNull();
      expect(bad!.rule).toMatch(/^no_/);
    }
    for (const c of CSS_ATTACKS) {
      const bad = checkCustomContent("<div></div>", c);
      expect(bad, c).not.toBeNull();
      expect(bad!.field).toBe("css");
    }
  });

  it("allows animated HTML/CSS with data: pictures and refuses content over 20 KB", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(
      checkCustomContent(
        `<div class="a" style="color:#123"><img src="${png}" alt=""><svg viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></svg></div>`,
        `.a{animation:s 1s infinite;background:url("${png}")}@keyframes s{to{opacity:0}}`,
      ),
    ).toBeNull();
    const big = "x".repeat(COMPONENT_LIMITS.contentBytes + 1);
    expect(checkCustomContent(big, "")).toMatchObject({ field: "html", rule: "too_large" });
    expect(checkCustomContent("", big)).toMatchObject({ field: "css", rule: "too_large" });
    // multi-byte characters count as UTF-8 bytes
    expect(checkCustomContent("é".repeat(COMPONENT_LIMITS.contentBytes / 2 + 1), "")?.rule).toBe(
      "too_large",
    );
  });
});

describe("sanitiser and CSS filter", () => {
  it("leave nothing that runs, loads or navigates", () => {
    for (const h of HTML_ATTACKS) {
      const out = sanitizeHtml(purify, h).toLowerCase();
      expect(out, h).not.toMatch(
        /<script|onerror|onclick|onload|javascript:|<iframe|<object|<embed|<form|<meta|<link|<base|<style|foreignobject|https?:|<a[\s>]/,
      );
    }
    for (const c of CSS_ATTACKS) {
      const out = filterCss(c).toLowerCase();
      expect(out, c).not.toMatch(
        /@import|https?:|expression\(|behavior:|-moz-binding|<|image-set\(/,
      );
    }
  });

  it("keeps safe markup and animations", () => {
    expect(sanitizeHtml(purify, '<div class="x"><b>Hi</b></div>')).toBe(
      '<div class="x"><b>Hi</b></div>',
    );
    expect(filterCss(".x{animation:a 1s}@keyframes a{to{opacity:0}}")).toBe(
      ".x{animation:a 1s}@keyframes a{to{opacity:0}}",
    );
  });
});

describe("srcdoc shell", () => {
  it("starts with the CSP meta as the first element in head", () => {
    const doc = buildComponentDoc(purify, { kind: "custom", html: "<p>x</p>", css: "p{}" }, false);
    expect(
      doc.startsWith(
        `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${COMPONENT_CSP}">`,
      ),
    ).toBe(true);
    expect(COMPONENT_CSP).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
    );
    const parsed = parse(doc);
    expect(parsed.head.firstElementChild?.getAttribute("http-equiv")).toBe(
      "Content-Security-Policy",
    );
    expect(parsed.querySelectorAll("style")).toHaveLength(2);
    expect(parsed.querySelectorAll("script, meta[http-equiv=refresh]")).toHaveLength(0);
  });

  it("the attack corpus can't escape the shell", () => {
    for (const h of HTML_ATTACKS)
      for (const c of CSS_ATTACKS) {
        const d = parse(buildComponentDoc(purify, { kind: "custom", html: h, css: c }, false));
        expect(
          d.querySelectorAll("script, iframe, object, embed, form, link, base, a"),
        ).toHaveLength(0);
        expect(d.querySelectorAll("style")).toHaveLength(2);
        expect(d.querySelectorAll("meta")).toHaveLength(2);
        expect(d.head.firstElementChild?.getAttribute("content")).toBe(COMPONENT_CSP);
      }
  });

  it("paused (reduced motion) adds the paused rule", () => {
    const src = { kind: "preset" as const, preset: "spinner" as const, params: {} };
    expect(buildComponentDoc(purify, src, true)).toMatch(/animation-play-state:paused!important/);
    expect(buildComponentDoc(purify, src, false)).not.toMatch(/animation-play-state/);
  });
});

describe("presets", () => {
  it("each preset renders, passes the content check and survives sanitising", () => {
    expect(PRESETS.map((p) => p.name)).toEqual([...PRESET_NAMES]);
    for (const p of PRESETS) {
      const { html, css } = renderPreset(p.name, {});
      expect(checkCustomContent(html, css), p.name).toBeNull();
      expect(sanitizeHtml(purify, html).length, p.name).toBeGreaterThan(0);
    }
  });

  it("checks parameters by type and range and escapes text", () => {
    expect(checkPresetParams("spinner", { color: "#ff0000", speed: 2 })).toBeNull();
    expect(checkPresetParams("spinner", { color: "red;}body{x" })?.path).toBe("params.color");
    expect(checkPresetParams("spinner", { speed: 99 })?.reason).toMatch(/0.2 to 10/);
    expect(checkPresetParams("spinner", { nope: 1 })?.path).toBe("params.nope");
    expect(checkPresetParams("bounce-arrow", { direction: "sideways" })?.reason).toMatch(
      /up, down/,
    );
    expect(checkPresetParams("hexagon", {})?.path).toBe("preset");
    const { html } = renderPreset("marquee", { text: "<img src=x onerror=alert(1)>" });
    expect(html).not.toMatch(/<img/);
    expect(html).toMatch(/&#60;img/);
  });
});

describe("component element", () => {
  const el = createComponent(
    10,
    20,
    { kind: "preset", preset: "pulse", params: { speed: 2 } },
    "Live",
  );
  it("validates strictly", () => {
    expect(validateStoredElement(el).ok).toBe(true);
    const bad = { ...el, source: { kind: "custom", html: "<script></script>", css: "" } };
    const r = validateStoredElement(bad);
    expect(r).toMatchObject({ ok: false, path: "source.html" });
    expect(validateStoredElement({ ...el, extra: 1 }).ok).toBe(false);
    expect(checkComponentSource({ kind: "custom", html: "", css: "", x: 1 })?.path).toBe(
      "source.x",
    );
  });

  it("round-trips through .chalana and exports a static SVG card", () => {
    const custom = createComponent(
      0,
      0,
      { kind: "custom", html: "<p>Hi</p>", css: "p{color:#123}" },
      "",
    );
    const text = serializeBoard(
      [el, custom],
      {},
      { viewBackgroundColor: "#ffffff", theme: "light", gridEnabled: false },
    );
    const back = parseBoard(text);
    expect(back.elements).toEqual([el, custom]);
    const svg = componentCardSvg(el, "light");
    expect(svg).toMatch(/Live/);
    expect(svg).toMatch(/Animated component/);
    expect(componentCardSvg(custom, "dark")).toMatch(/Custom component/);
  });
});

describe("reduced motion", () => {
  it("pauses components unless this tab chose to play anyway", async () => {
    const { isComponentPaused, setPlayAnyway } = await import("../render/media");
    const el = createComponent(0, 0, { kind: "preset", preset: "pulse", params: {} }, "");
    let reduce = false;
    const mm = (q: string) =>
      ({
        matches: reduce && q.includes("reduce"),
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList;
    const prev = window.matchMedia;
    window.matchMedia = mm;
    globalThis.matchMedia = mm;
    try {
      expect(isComponentPaused(el)).toBe(false);
      expect(isComponentPaused({ ...el, paused: true })).toBe(true);
      reduce = true;
      expect(isComponentPaused(el)).toBe(true);
      setPlayAnyway(el.id, true);
      expect(isComponentPaused(el)).toBe(false);
      setPlayAnyway(el.id, false);
    } finally {
      window.matchMedia = prev;
      globalThis.matchMedia = prev;
    }
  });
});
