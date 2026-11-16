import { BOUND_TEXT_PADDING, FONT_FAMILIES, LINE_HEIGHT } from "./constants";
import type { FontFamily, SceneElement, TextElement } from "./types";

export type MeasureFn = (text: string, font: string) => number;

let ctx: CanvasRenderingContext2D | null | undefined;

/** Measures with a canvas when available; falls back to an estimate (tests, SSR). */
export const defaultMeasure: MeasureFn = (text, font) => {
  if (ctx === undefined) {
    try {
      ctx =
        typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
    } catch {
      ctx = null;
    }
  }
  if (ctx) {
    ctx.font = font;
    return ctx.measureText(text).width;
  }
  const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? "20");
  return text.length * size * 0.55;
};

let measure: MeasureFn = defaultMeasure;
export const setMeasure = (fn: MeasureFn) => {
  measure = fn;
};

export const fontString = (family: FontFamily, size: number) =>
  `${size}px ${FONT_FAMILIES[family].css}`;

export const lineHeightPx = (fontSize: number) => fontSize * LINE_HEIGHT;

/** Splits text into lines, wrapping words at `maxWidth` when given. */
export const wrapText = (text: string, font: string, maxWidth: number | null): string[] => {
  const paragraphs = text.split("\n");
  if (maxWidth === null) return paragraphs;
  const lines: string[] = [];
  for (const para of paragraphs) {
    if (para === "") {
      lines.push("");
      continue;
    }
    const words = para.split(/(\s+)/);
    let current = "";
    for (const word of words) {
      const candidate = current + word;
      if (measure(candidate, font) <= maxWidth || current === "") {
        if (current === "" && measure(word, font) > maxWidth && word.trim()) {
          // break very long words by character
          let chunk = "";
          for (const ch of word) {
            if (measure(chunk + ch, font) > maxWidth && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          current = chunk;
        } else current = candidate;
      } else {
        lines.push(current.trimEnd());
        current = word.trimStart();
      }
    }
    lines.push(current.trimEnd());
  }
  return lines;
};

export const measureLines = (lines: string[], font: string) =>
  Math.max(0, ...lines.map((l) => measure(l, font)));

/** Usable inner width of a container shape for bound text. */
export const containerTextWidth = (container: SceneElement) => {
  const factor =
    container.type === "ellipse" ? Math.SQRT1_2 : container.type === "diamond" ? 0.5 : 1;
  return Math.max(10, container.width * factor - BOUND_TEXT_PADDING * 2);
};

export const containerTextHeight = (container: SceneElement) => {
  const factor =
    container.type === "ellipse" ? Math.SQRT1_2 : container.type === "diamond" ? 0.5 : 1;
  return Math.max(10, container.height * factor - BOUND_TEXT_PADDING * 2);
};

export const getTextLines = (el: TextElement) =>
  wrapText(el.text, fontString(el.fontFamily, el.fontSize), el.autoWidth ? null : el.width);

/** Recomputes width/height of a free text element from its content. */
export const layoutText = (el: TextElement): TextElement => {
  const font = fontString(el.fontFamily, el.fontSize);
  const lines = wrapText(el.text, font, el.autoWidth ? null : el.width);
  const width = el.autoWidth ? Math.max(measureLines(lines, font), 4) : el.width;
  const height = lines.length * lineHeightPx(el.fontSize);
  if (el.autoWidth && el.textAlign !== "left") {
    // keep the anchor edge stable when content grows
    const dx = el.textAlign === "center" ? (width - el.width) / 2 : width - el.width;
    return { ...el, x: el.x - dx, width, height };
  }
  return { ...el, width, height };
};
