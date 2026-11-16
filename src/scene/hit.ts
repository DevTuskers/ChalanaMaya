import { TRANSPARENT } from "./constants";
import { hasPoints, isFillable, isLinear } from "./elements";
import { routedPoints } from "./route";
import {
  boundsContain,
  distanceToSegment,
  getAbsolutePoints,
  getElementBounds,
  pointInPolygon,
  toLocal,
} from "./geometry";
import { isSelectable, type Elements } from "./scene";
import type { Bounds, Point, SceneElement } from "./types";

const outlineDistance = (el: SceneElement, local: Point): number => {
  const { x, y, width: w, height: h } = el;
  if (el.type === "ellipse") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = Math.max(w / 2, 1e-6);
    const ry = Math.max(h / 2, 1e-6);
    const nx = (local.x - cx) / rx;
    const ny = (local.y - cy) / ry;
    const r = Math.hypot(nx, ny);
    return Math.abs(r - 1) * Math.min(rx, ry);
  }
  const poly: Point[] =
    el.type === "diamond"
      ? [
          { x: x + w / 2, y },
          { x: x + w, y: y + h / 2 },
          { x: x + w / 2, y: y + h },
          { x, y: y + h / 2 },
        ]
      : [
          { x, y },
          { x: x + w, y },
          { x: x + w, y: y + h },
          { x, y: y + h },
        ];
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    d = Math.min(d, distanceToSegment(local, poly[i], poly[(i + 1) % poly.length]));
  }
  return d;
};

const insideShape = (el: SceneElement, local: Point): boolean => {
  const { x, y, width: w, height: h } = el;
  if (el.type === "ellipse") {
    const nx = (local.x - (x + w / 2)) / (w / 2);
    const ny = (local.y - (y + h / 2)) / (h / 2);
    return nx * nx + ny * ny <= 1;
  }
  if (el.type === "diamond") {
    return (
      Math.abs(local.x - (x + w / 2)) / (w / 2) + Math.abs(local.y - (y + h / 2)) / (h / 2) <= 1
    );
  }
  return local.x >= x && local.x <= x + w && local.y >= y && local.y <= y + h;
};

/** Whether board point `p` touches the element. `tolerance` is in board units. */
export const hitElement = (
  el: SceneElement,
  p: Point,
  tolerance: number,
  elements: Elements = [],
): boolean => {
  if (hasPoints(el)) {
    const pts = isLinear(el) ? routedPoints(el) : getAbsolutePoints(el);
    const tol = tolerance + el.strokeWidth / 2;
    if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= tol;
    const closed = el.type === "line" && el.closed;
    for (let i = 0; i < pts.length - 1; i++) {
      if (distanceToSegment(p, pts[i], pts[i + 1]) <= tol) return true;
    }
    if (closed && el.backgroundColor !== TRANSPARENT && pointInPolygon(p, pts)) return true;
    if (isLinear(el)) {
      const label = elements.find((e) => e.type === "text" && e.containerId === el.id);
      if (label && label.type === "text" && label.text.trim() && hitElement(label, p, tolerance)) return true;
    }
    return false;
  }
  const local = toLocal(p, el);
  if (el.type === "frame") {
    const onTitle =
      local.y >= el.y - 24 && local.y <= el.y && local.x >= el.x && local.x <= el.x + Math.max(60, Math.min(el.width, 200));
    return onTitle || outlineDistance(el, local) <= tolerance + 2;
  }
  if (el.type === "text" || el.type === "image") {
    return (
      local.x >= el.x - tolerance &&
      local.x <= el.x + el.width + tolerance &&
      local.y >= el.y - tolerance &&
      local.y <= el.y + el.height + tolerance
    );
  }
  if (outlineDistance(el, local) <= tolerance + el.strokeWidth / 2) return true;
  if (isFillable(el) && el.backgroundColor !== TRANSPARENT && insideShape(el, local)) return true;
  // text inside a transparent shape also picks the shape
  const bound = elements.find((e) => e.type === "text" && e.containerId === el.id);
  if (bound && bound.type === "text" && bound.text.trim() && hitElement(bound, p, tolerance)) {
    return true;
  }
  return false;
};

/** Topmost selectable element under `p`. */
export const elementAt = (elements: Elements, p: Point, tolerance: number): SceneElement | null => {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!isSelectable(el)) continue;
    if (hitElement(el, p, tolerance, elements)) return el;
  }
  return null;
};

/** Selectable elements fully enclosed by the box. */
export const elementsInBox = (elements: Elements, box: Bounds): SceneElement[] =>
  elements.filter((el) => isSelectable(el) && boundsContain(box, getElementBounds(el)));

export { insideShape };
