import type { Point, ShapeType } from "./types";

export interface Recognized {
  type: ShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Mean outline error, normalised to the shape size (lower is better). */
  error: number;
}

/** Above this mean normalised error a sketch is not considered a clean shape. */
const MAX_ERROR = 0.11;

/**
 * Shape tidy (DRAW-18): decides whether a rough closed outline is a box, diamond
 * or oval. Returns null for anything that is not clearly one of them.
 */
export const recognizeShape = (points: readonly Point[]): Recognized | null => {
  if (points.length < 8) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < 16 || h < 16) return null;
  // very thin outlines are lines, not shapes
  if (Math.min(w, h) / Math.max(w, h) < 0.15) return null;
  const diag = Math.hypot(w, h);
  const first = points[0];
  const last = points[points.length - 1];
  // the outline must come back near where it started
  if (Math.hypot(first.x - last.x, first.y - last.y) > diag * 0.22) return null;

  const cx = minX + w / 2;
  const cy = minY + h / 2;
  const norm = points.map((p) => ({ u: (p.x - cx) / (w / 2), v: (p.y - cy) / (h / 2) }));

  // the stroke must go all the way round the centre
  const bins = new Set<number>();
  for (const { u, v } of norm) {
    const a = Math.atan2(v, u);
    bins.add(Math.floor(((a + Math.PI) / (2 * Math.PI)) * 16) % 16);
  }
  if (bins.size < 14) return null;

  const mean = (f: (u: number, v: number) => number) =>
    norm.reduce((s, { u, v }) => s + f(u, v), 0) / norm.length;
  const errors: { type: ShapeType; error: number }[] = [
    { type: "rectangle", error: mean((u, v) => Math.abs(Math.max(Math.abs(u), Math.abs(v)) - 1)) },
    { type: "ellipse", error: mean((u, v) => Math.abs(Math.hypot(u, v) - 1)) },
    {
      type: "diamond",
      error: mean((u, v) => Math.abs(Math.abs(u) + Math.abs(v) - 1) / Math.SQRT2),
    },
  ];
  errors.sort((a, b) => a.error - b.error);
  const best = errors[0];
  if (best.error > MAX_ERROR) return null;
  // ambiguous: two candidates fit about equally well
  if (errors[1].error - best.error < 0.015) return null;
  return { type: best.type, x: minX, y: minY, width: w, height: h, error: best.error };
};

export const SHAPE_NAMES: Record<ShapeType, string> = {
  rectangle: "box",
  diamond: "diamond",
  ellipse: "oval",
};
