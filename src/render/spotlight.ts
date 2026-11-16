/**
 * Spotlight (DRAW-16): a temporary, fading pointer trail. Lives only in memory and
 * on the overlay, never in the board's elements, history or saved files.
 */
import type { SpotlightStroke } from "../store/store";
import type { Theme, Viewport } from "../scene/types";

/** How long a trail point stays visible, in ms. */
export const SPOTLIGHT_LIFE = 1100;

/** Drops faded points and empty strokes. Returns the same array when nothing changed. */
export const pruneSpotlight = (
  strokes: SpotlightStroke[],
  now: number,
  life = SPOTLIGHT_LIFE,
  /** The stroke still being drawn keeps its last point so the dot stays visible. */
  keepLast = false,
): SpotlightStroke[] => {
  let changed = false;
  const out: SpotlightStroke[] = [];
  strokes.forEach((s, i) => {
    const live = i === strokes.length - 1 && keepLast;
    const pts = s.points.filter((p) => now - p.t < life);
    if (live && !pts.length && s.points.length) pts.push(s.points[s.points.length - 1]);
    if (pts.length !== s.points.length) changed = true;
    if (pts.length) out.push(pts.length === s.points.length ? s : { points: pts });
    else changed = true;
  });
  return changed ? out : strokes;
};

/** Opacity of a trail point drawn at time `t`. */
export const spotlightAlpha = (t: number, now: number, life = SPOTLIGHT_LIFE) =>
  Math.max(0, Math.min(1, 1 - (now - t) / life));

export const SPOTLIGHT_COLOR = { light: "#b65b24", dark: "#f3ad73" } as const;

export const drawSpotlight = (
  ctx: CanvasRenderingContext2D,
  strokes: SpotlightStroke[],
  viewport: Viewport,
  theme: Theme,
  now: number,
) => {
  const { zoom, scrollX, scrollY } = viewport;
  const color = SPOTLIGHT_COLOR[theme];
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  for (const s of strokes) {
    const pts = s.points.map((p) => ({
      x: (p.x + scrollX) * zoom,
      y: (p.y + scrollY) * zoom,
      a: spotlightAlpha(p.t, now),
    }));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      ctx.globalAlpha = b.a;
      ctx.lineWidth = 2 + 4 * b.a;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const last = pts[pts.length - 1];
    if (last) {
      ctx.globalAlpha = last.a;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
};
