/**
 * Server text measuring (plan §3.8). Reads the same @fontsource font
 * files the app bundles with fontkit, so labels an agent adds get sizes close
 * to the browser's. The first open tab still corrects them once (needsLayout).
 */
import { createRequire } from "node:module";
import { create, type Font } from "fontkit";
import { readFileSync } from "node:fs";
import { defaultMeasure, setMeasure, type MeasureFn } from "../../src/scene/text";

const require = createRequire(import.meta.url);

/** First family name of a CSS font list → the bundled file (latin, weight 400, woff2: fontkit misreads the Plex Mono .woff). */
const FILES: Record<string, string> = {
  kalam: "@fontsource/kalam/files/kalam-latin-400-normal.woff2",
  "source sans 3": "@fontsource/source-sans-3/files/source-sans-3-latin-400-normal.woff2",
  "ibm plex mono": "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
};

const fonts = new Map<string, Font | null>();

const loadFont = (family: string): Font | null => {
  if (fonts.has(family)) return fonts.get(family)!;
  let font: Font | null = null;
  const spec = FILES[family];
  if (spec) {
    try {
      const f = create(readFileSync(require.resolve(spec)));
      font = "layout" in f ? (f as Font) : null;
    } catch {
      font = null;
    }
  }
  fonts.set(family, font);
  return font;
};

const parseFont = (font: string): { size: number; family: string } => {
  const m = /(\d+(?:\.\d+)?)px\s+(.*)$/.exec(font);
  const size = m ? parseFloat(m[1]!) : 20;
  const first = (m?.[2] ?? "").split(",")[0] ?? "";
  return {
    size,
    family: first
      .trim()
      .replace(/^["']|["']$/g, "")
      .toLowerCase(),
  };
};

const CACHE_MAX = 20_000;
const cache = new Map<string, number>();

/** Width of `text` in px for a canvas-style font string (`"20px \"Kalam\", …"`). */
export const fontkitMeasure: MeasureFn = (text, fontString) => {
  const key = fontString + "\u0000" + text;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const { size, family } = parseFont(fontString);
  const font = loadFont(family);
  let width = defaultMeasure(text, fontString);
  if (font) {
    try {
      const run = font.layout(text);
      const scale = size / font.unitsPerEm;
      let sum = 0;
      // characters outside the latin subset fall back to the estimate per glyph,
      // as the browser falls back to another font for them
      run.glyphs.forEach((glyph, i) => {
        if (glyph.id === 0) sum += size * 0.55;
        else sum += (run.positions[i]?.xAdvance ?? glyph.advanceWidth) * scale;
      });
      width = sum;
    } catch {
      // a font table fontkit cannot read: keep the estimate
    }
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, width);
  return width;
};

/** True when all three bundled fonts load (a broken install falls back to the estimate). */
export const fontsAvailable = () => Object.keys(FILES).every((family) => loadFont(family) !== null);

/** Installs the fontkit measurer for all shared scene code in this process. */
export const installServerMeasure = () => setMeasure(fontkitMeasure);
