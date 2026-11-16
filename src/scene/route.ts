import { getAbsolutePoints } from "./geometry";
import type { LinearElement, Point } from "./types";

/** Orthogonal polyline through the given waypoints (horizontal first when wider). */
export const elbowRoute = (pts: Point[]): Point[] => {
  if (pts.length < 2) return pts.map((p) => ({ ...p }));
  const out: Point[] = [{ ...pts[0] }];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    if (a.x === b.x || a.y === b.y) {
      out.push({ ...b });
      continue;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const mx = a.x + dx / 2;
      out.push({ x: mx, y: a.y }, { x: mx, y: b.y }, { ...b });
    } else {
      const my = a.y + dy / 2;
      out.push({ x: a.x, y: my }, { x: b.x, y: my }, { ...b });
    }
  }
  return out;
};

/** Smooth curve through waypoints (Catmull-Rom); two points get a gentle bow. */
export const curveRoute = (pts: Point[], samples = 16): Point[] => {
  if (pts.length < 2) return pts.map((p) => ({ ...p }));
  let through = pts;
  if (pts.length === 2) {
    const [a, b] = pts;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / (len || 1);
    const ny = (b.x - a.x) / (len || 1);
    const bow = len * 0.18;
    through = [a, { x: (a.x + b.x) / 2 + nx * bow, y: (a.y + b.y) / 2 + ny * bow }, b];
  }
  const out: Point[] = [];
  for (let i = 0; i < through.length - 1; i++) {
    const p0 = through[Math.max(0, i - 1)];
    const p1 = through[i];
    const p2 = through[i + 1];
    const p3 = through[Math.min(through.length - 1, i + 2)];
    for (let s = 0; s < samples; s++) {
      const t = s / samples;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push({ ...through[through.length - 1] });
  return out;
};

/** The polyline that is actually drawn for a connector or path, in board units. */
export const routedPoints = (el: LinearElement): Point[] => {
  const abs = getAbsolutePoints(el);
  if (el.type !== "arrow" || el.routing === "straight") return abs;
  return el.routing === "elbow" ? elbowRoute(abs) : curveRoute(abs);
};

/** Point halfway along a polyline (by length). */
export const polylineMidpoint = (pts: Point[]): Point => {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return { ...pts[0] };
  let total = 0;
  for (let i = 1; i < pts.length; i++)
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (half <= seg && seg > 0) {
      const t = half / seg;
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      };
    }
    half -= seg;
  }
  return { ...pts[pts.length - 1] };
};
