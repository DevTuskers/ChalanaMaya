import { FONT_FAMILIES } from "../scene/constants";
import { defaultMeasure, fontString, setMeasure, type MeasureFn } from "../scene/text";
import type { FontFamily } from "../scene/types";

let ctx: CanvasRenderingContext2D | null | undefined;

/** Measures text with a canvas; falls back to the estimate when no canvas is available. */
export const canvasMeasure: MeasureFn = (text, font) => {
  if (ctx === undefined) {
    try {
      ctx = document.createElement("canvas").getContext("2d");
    } catch {
      ctx = null;
    }
  }
  if (!ctx) return defaultMeasure(text, font);
  ctx.font = font;
  return ctx.measureText(text).width;
};

/** Called once at start-up so scene code stays DOM-free. */
export const installCanvasMeasure = () => setMeasure(canvasMeasure);

/**
 * Resolves once the three board fonts are loaded (or after `timeoutMs`), so
 * text measured afterwards uses the real fonts. Fonts load lazily, so each one
 * is requested explicitly.
 */
export const whenBoardFontsReady = (doc: Document, timeoutMs = 3000): Promise<void> => {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts?.load) return Promise.resolve();
  const all = Promise.all(
    (Object.keys(FONT_FAMILIES) as FontFamily[]).map((f) =>
      fonts.load(fontString(f, 20)).catch(() => []),
    ),
  ).then(() => undefined);
  return Promise.race([all, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
};
