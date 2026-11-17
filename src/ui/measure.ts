import { defaultMeasure, setMeasure, type MeasureFn } from "../scene/text";

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
