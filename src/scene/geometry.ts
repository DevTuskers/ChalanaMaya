import type { Bounds, Point, SceneElement } from "./types";

export const rotatePoint = (p: Point, center: Point, angle: number): Point => {
  if (!angle) return { x: p.x, y: p.y };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
};

export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export const distanceToSegment = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
};

export const pointInPolygon = (p: Point, poly: Point[]): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
};

export const getCenter = (el: Pick<SceneElement, "x" | "y" | "width" | "height">): Point => ({
  x: el.x + el.width / 2,
  y: el.y + el.height / 2,
});

/** Corners of the element box in board coordinates (rotation applied). */
export const getCorners = (el: SceneElement): Point[] => {
  const c = getCenter(el);
  return [
    { x: el.x, y: el.y },
    { x: el.x + el.width, y: el.y },
    { x: el.x + el.width, y: el.y + el.height },
    { x: el.x, y: el.y + el.height },
  ].map((p) => rotatePoint(p, c, el.angle));
};

export const boundsOfPoints = (pts: Point[]): Bounds => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
};

/** Axis-aligned bounds that contain the element after rotation. */
export const getElementBounds = (el: SceneElement): Bounds => {
  if ((el.type === "arrow" || el.type === "line" || el.type === "freedraw") && el.points.length) {
    return boundsOfPoints(getAbsolutePoints(el));
  }
  return boundsOfPoints(getCorners(el));
};

export const getCommonBounds = (els: readonly SceneElement[]): Bounds | null => {
  if (!els.length) return null;
  const all = els.map(getElementBounds);
  return {
    minX: Math.min(...all.map((b) => b.minX)),
    minY: Math.min(...all.map((b) => b.minY)),
    maxX: Math.max(...all.map((b) => b.maxX)),
    maxY: Math.max(...all.map((b) => b.maxY)),
  };
};

export const boundsContain = (outer: Bounds, inner: Bounds) =>
  inner.minX >= outer.minX &&
  inner.maxX <= outer.maxX &&
  inner.minY >= outer.minY &&
  inner.maxY <= outer.maxY;

export const normalizeRect = (a: Point, b: Point): Bounds => ({
  minX: Math.min(a.x, b.x),
  minY: Math.min(a.y, b.y),
  maxX: Math.max(a.x, b.x),
  maxY: Math.max(a.y, b.y),
});

type PointElement = { x: number; y: number; width: number; height: number; angle: number } & {
  points: Point[];
};

/** Points of a linear or freedraw element in board coordinates (rotation applied). */
export const getAbsolutePoints = (el: PointElement): Point[] => {
  const c = getCenter(el);
  return el.points.map((p) => rotatePoint({ x: el.x + p.x, y: el.y + p.y }, c, el.angle));
};

/**
 * Re-derives x/y/width/height from absolute points so the box tightly wraps
 * them. The returned element is unrotated.
 */
export const fromAbsolutePoints = <T extends PointElement>(el: T, abs: Point[]): T => {
  const b = boundsOfPoints(abs);
  return {
    ...el,
    x: b.minX,
    y: b.minY,
    width: b.maxX - b.minX,
    height: b.maxY - b.minY,
    angle: 0,
    points: abs.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY })),
  };
};

/** Shifts points so the smallest is at (0,0) and updates the box, keeping rotation. */
export const normalizePoints = <T extends PointElement>(el: T): T => {
  if (!el.points.length) return el;
  const b = boundsOfPoints(el.points);
  const width = b.maxX - b.minX;
  const height = b.maxY - b.minY;
  // keep the rotated position of points stable when the box changes
  const oldCenter = getCenter(el);
  const newLocalCenter = { x: el.x + b.minX + width / 2, y: el.y + b.minY + height / 2 };
  const newCenter = rotatePoint(newLocalCenter, oldCenter, el.angle);
  return {
    ...el,
    x: newCenter.x - width / 2,
    y: newCenter.y - height / 2,
    width,
    height,
    points: el.points.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY })),
  };
};

/** Converts a board point into the element's unrotated frame. */
export const toLocal = (p: Point, el: SceneElement): Point =>
  rotatePoint(p, getCenter(el), -el.angle);

export const snapAngle = (angle: number, stepDeg = 15) => {
  const step = (stepDeg * Math.PI) / 180;
  return Math.round(angle / step) * step;
};

export const normalizeAngle = (a: number) => {
  const full = Math.PI * 2;
  let r = a % full;
  if (r < 0) r += full;
  return r;
};
