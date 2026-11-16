/**
 * Board overview (VIEW-05): maps between the board and a small overview panel.
 * Pure geometry so it can be unit tested.
 */
import type { Bounds, Point, Viewport } from "../scene/types";

export interface MinimapLayout {
  /** Overview px per board unit. */
  scale: number;
  /** Board region shown, including padding. */
  world: Bounds;
  /** The visible part of the board, in overview px. */
  view: { x: number; y: number; width: number; height: number };
  /** Viewport to render the board into the overview canvas. */
  viewport: Viewport;
}

/** Board area currently visible in the main view. */
export const visibleBounds = (v: Viewport, size: { width: number; height: number }): Bounds => ({
  minX: -v.scrollX,
  minY: -v.scrollY,
  maxX: -v.scrollX + size.width / v.zoom,
  maxY: -v.scrollY + size.height / v.zoom,
});

export const minimapLayout = (
  content: Bounds | null,
  viewport: Viewport,
  viewSize: { width: number; height: number },
  panel: { width: number; height: number },
): MinimapLayout => {
  const vis = visibleBounds(viewport, viewSize);
  const b = content
    ? {
        minX: Math.min(content.minX, vis.minX),
        minY: Math.min(content.minY, vis.minY),
        maxX: Math.max(content.maxX, vis.maxX),
        maxY: Math.max(content.maxY, vis.maxY),
      }
    : vis;
  const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1) * 0.06;
  let world = { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
  const ww = Math.max(world.maxX - world.minX, 1);
  const wh = Math.max(world.maxY - world.minY, 1);
  const scale = Math.min(panel.width / ww, panel.height / wh);
  // centre the region in the panel
  const extraX = panel.width / scale - ww;
  const extraY = panel.height / scale - wh;
  world = {
    minX: world.minX - extraX / 2,
    minY: world.minY - extraY / 2,
    maxX: world.maxX + extraX / 2,
    maxY: world.maxY + extraY / 2,
  };
  return {
    scale,
    world,
    view: {
      x: (vis.minX - world.minX) * scale,
      y: (vis.minY - world.minY) * scale,
      width: (vis.maxX - vis.minX) * scale,
      height: (vis.maxY - vis.minY) * scale,
    },
    viewport: { zoom: scale, scrollX: -world.minX, scrollY: -world.minY },
  };
};

/** Board point under an overview position. */
export const minimapToBoard = (layout: MinimapLayout, p: Point): Point => ({
  x: layout.world.minX + p.x / layout.scale,
  y: layout.world.minY + p.y / layout.scale,
});

/** Main-view viewport that centres the given board point, keeping the zoom. */
export const centerViewportOn = (
  v: Viewport,
  p: Point,
  viewSize: { width: number; height: number },
): Viewport => ({
  ...v,
  scrollX: viewSize.width / (2 * v.zoom) - p.x,
  scrollY: viewSize.height / (2 * v.zoom) - p.y,
});
