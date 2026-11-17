import { hasPoints, isLinear } from "./elements";
import { wrapAngle } from "../shared/limits";
import { getCenter, getCommonBounds, normalizePoints, rotatePoint } from "./geometry";
import { withDependents } from "./arrange";
import { withBoundTexts, type Elements } from "./scene";
import { layoutText } from "./text";
import type { Bounds, Point, SceneElement } from "./types";

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_SIZE = 2;

/** Moves elements; arrows moved without their attached shape are detached. */
export const moveElements = (
  elements: Elements,
  ids: ReadonlySet<string>,
  dx: number,
  dy: number,
): SceneElement[] => {
  const moving = withDependents(elements, ids);
  return elements.map((el) => {
    if (!moving.has(el.id) || el.locked) return el;
    const moved = { ...el, x: el.x + dx, y: el.y + dy } as SceneElement;
    if (isLinear(moved) && moved.type === "arrow") {
      if (moved.startBinding && !moving.has(moved.startBinding.elementId))
        moved.startBinding = null;
      if (moved.endBinding && !moving.has(moved.endBinding.elementId)) moved.endBinding = null;
    }
    return moved;
  });
};

const scalePoints = (el: SceneElement, sx: number, sy: number): SceneElement => {
  if (!hasPoints(el)) return el;
  return { ...el, points: el.points.map((p) => ({ x: p.x * sx, y: p.y * sy })) };
};

/** Resizes one element by dragging `handle` to board point `p`. */
export const resizeElement = (
  el: SceneElement,
  handle: Handle,
  p: Point,
  keepRatio: boolean,
): SceneElement => {
  const c0 = getCenter(el);
  const lp = rotatePoint(p, c0, -el.angle);
  let x0 = el.x;
  let y0 = el.y;
  let x1 = el.x + el.width;
  let y1 = el.y + el.height;
  if (handle.includes("w")) x0 = lp.x;
  if (handle.includes("e")) x1 = lp.x;
  if (handle.includes("n")) y0 = lp.y;
  if (handle.includes("s")) y1 = lp.y;

  const isCorner = handle.length === 2;
  const forceRatio = keepRatio || el.type === "image" || (isCorner && el.type === "text");

  if (el.type === "text") {
    if (handle === "n" || handle === "s") return el;
    if (!isCorner) {
      const width = Math.max(x1 - x0, el.fontSize);
      const anchorX = handle === "e" ? el.x : el.x + el.width;
      const laid = layoutText({ ...el, autoWidth: false, width });
      const nx = handle === "e" ? anchorX : anchorX - width;
      return placeLocal(el, laid, nx, el.y, c0);
    }
  }

  let w = x1 - x0;
  let h = y1 - y0;
  if (forceRatio && el.width > 0 && el.height > 0) {
    const ratio = el.width / el.height;
    if (isCorner) {
      if (Math.abs(w) / el.width > Math.abs(h) / el.height)
        h = (Math.abs(w) / ratio) * Math.sign(h || 1);
      else w = Math.abs(h) * ratio * Math.sign(w || 1);
    } else if (handle === "e" || handle === "w") {
      h = Math.abs(w) / ratio;
    } else {
      w = Math.abs(h) * ratio;
    }
    if (handle.includes("w")) x0 = x1 - w;
    else if (handle.includes("e")) x1 = x0 + w;
    else {
      const cx = el.x + el.width / 2;
      x0 = cx - w / 2;
      x1 = cx + w / 2;
    }
    if (handle.includes("n")) y0 = y1 - h;
    else if (handle.includes("s")) y1 = y0 + h;
    else {
      const cy = el.y + el.height / 2;
      y0 = cy - h / 2;
      y1 = cy + h / 2;
    }
  }

  if (el.type === "text") {
    const s = Math.max(Math.abs(w) / el.width, 0.1);
    const fontSize = Math.max(4, el.fontSize * s);
    const laid = layoutText({
      ...el,
      fontSize,
      width: el.autoWidth ? el.width : el.width * s,
    });
    const nx = handle.includes("w") ? el.x + el.width - laid.width : el.x;
    const ny = handle.includes("n") ? el.y + el.height - laid.height : el.y;
    return placeLocal(el, laid, nx, ny, c0);
  }

  if (hasPoints(el)) {
    const sx = el.width > 0 ? w / el.width : 1;
    const sy = el.height > 0 ? h / el.height : 1;
    const scaled = scalePoints(el, sx, sy) as SceneElement & { points: Point[] };
    // place the scaled point cloud at the new local box origin
    const lx = Math.min(x0, x1);
    const ly = Math.min(y0, y1);
    const withBox = normalizePoints({ ...scaled, angle: 0, x: 0, y: 0 });
    const target = { ...withBox, x: lx, y: ly };
    return placeLocal(el, target, lx, ly, c0);
  }

  const nx = Math.min(x0, x0 + w);
  const ny = Math.min(y0, y0 + h);
  const resized = {
    ...el,
    width: Math.max(Math.abs(w), MIN_SIZE),
    height: Math.max(Math.abs(h), MIN_SIZE),
  };
  return placeLocal(el, resized, nx, ny, c0);
};

/** Puts `next` (sized in the old local frame at nx,ny) back into board space. */
const placeLocal = (
  old: SceneElement,
  next: SceneElement,
  nx: number,
  ny: number,
  oldCenter: Point,
): SceneElement => {
  const localCenter = { x: nx + next.width / 2, y: ny + next.height / 2 };
  const c = rotatePoint(localCenter, oldCenter, old.angle);
  return { ...next, x: c.x - next.width / 2, y: c.y - next.height / 2, angle: old.angle };
};

/** Anchor point that stays fixed while dragging a handle of `b`. */
const anchorFor = (b: Bounds, handle: Handle): Point => {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return {
    x: handle.includes("w") ? b.maxX : handle.includes("e") ? b.minX : cx,
    y: handle.includes("n") ? b.maxY : handle.includes("s") ? b.minY : cy,
  };
};

/** Uniformly scales a multi-selection so the arrangement is preserved. */
export const resizeGroup = (
  elements: Elements,
  ids: ReadonlySet<string>,
  start: Bounds,
  handle: Handle,
  p: Point,
): SceneElement[] => {
  const w0 = Math.max(start.maxX - start.minX, 1e-6);
  const h0 = Math.max(start.maxY - start.minY, 1e-6);
  const anchor = anchorFor(start, handle);
  const sw = Math.abs(p.x - anchor.x) / w0;
  const sh = Math.abs(p.y - anchor.y) / h0;
  let s = handle.length === 2 ? Math.max(sw, sh) : handle === "e" || handle === "w" ? sw : sh;
  s = Math.max(s, 0.05);
  const scaling = withBoundTexts(elements, ids);
  return elements.map((el) => {
    if (!scaling.has(el.id) || el.locked) return el;
    const c = getCenter(el);
    const nc = { x: anchor.x + (c.x - anchor.x) * s, y: anchor.y + (c.y - anchor.y) * s };
    const width = el.width * s;
    const height = el.height * s;
    let next = { ...el, width, height, x: nc.x - width / 2, y: nc.y - height / 2 } as SceneElement;
    next = scalePoints(next, s, s);
    if (next.type === "text" && el.type === "text") next = { ...next, fontSize: el.fontSize * s };
    return next;
  });
};

/** Rotates elements by `delta` radians around `center`. */
export const rotateElements = (
  elements: Elements,
  ids: ReadonlySet<string>,
  center: Point,
  delta: number,
): SceneElement[] => {
  const rotating = withBoundTexts(elements, ids);
  return elements.map((el) => {
    if (!rotating.has(el.id) || el.locked) return el;
    const c = rotatePoint(getCenter(el), center, delta);
    return {
      ...el,
      x: c.x - el.width / 2,
      y: c.y - el.height / 2,
      angle: wrapAngle(el.angle + delta),
    };
  });
};

export const selectionBounds = (elements: Elements, ids: ReadonlySet<string>) =>
  getCommonBounds(elements.filter((e) => ids.has(e.id)));
