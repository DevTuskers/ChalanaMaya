import { MAX_ZOOM, MIN_ZOOM } from "./constants";
import type { Bounds, Point, Viewport } from "./types";

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export const screenToScene = (p: Point, v: Viewport): Point => ({
  x: p.x / v.zoom - v.scrollX,
  y: p.y / v.zoom - v.scrollY,
});

export const sceneToScreen = (p: Point, v: Viewport): Point => ({
  x: (p.x + v.scrollX) * v.zoom,
  y: (p.y + v.scrollY) * v.zoom,
});

/** Changes zoom while keeping the board point under `screenPoint` fixed. */
export const zoomAt = (v: Viewport, zoom: number, screenPoint: Point): Viewport => {
  const z = clampZoom(zoom);
  const scene = screenToScene(screenPoint, v);
  return { zoom: z, scrollX: screenPoint.x / z - scene.x, scrollY: screenPoint.y / z - scene.y };
};

export const panBy = (v: Viewport, dxScreen: number, dyScreen: number): Viewport => ({
  ...v,
  scrollX: v.scrollX + dxScreen / v.zoom,
  scrollY: v.scrollY + dyScreen / v.zoom,
});

/** Viewport that frames `b` inside a `width`×`height` screen with a margin. */
export const fitBounds = (
  b: Bounds | null,
  width: number,
  height: number,
  margin = 48,
  maxZoom = 2,
): Viewport | null => {
  if (!b || !isFinite(b.minX) || width <= 0 || height <= 0) return null;
  const bw = Math.max(b.maxX - b.minX, 1);
  const bh = Math.max(b.maxY - b.minY, 1);
  const availW = Math.max(width - margin * 2, 1);
  const availH = Math.max(height - margin * 2, 1);
  const zoom = clampZoom(Math.min(availW / bw, availH / bh, maxZoom));
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return { zoom, scrollX: width / 2 / zoom - cx, scrollY: height / 2 / zoom - cy };
};

/** Board-space rectangle currently visible. */
export const visibleBounds = (v: Viewport, width: number, height: number): Bounds => {
  const a = screenToScene({ x: 0, y: 0 }, v);
  const b = screenToScene({ x: width, y: height }, v);
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
};
