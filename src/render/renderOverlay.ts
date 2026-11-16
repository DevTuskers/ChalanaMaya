import { isLinear } from "../scene/elements";
import { getAbsolutePoints, getCorners } from "../scene/geometry";
import type { Bounds, Point, SceneElement, Theme, Viewport } from "../scene/types";
import {
  HANDLE_SIZE,
  getHandleLayout,
  getTransformBox,
  paddedBoxCorners,
  usesEndpointHandlesOnly,
} from "./handles";

export interface OverlayOptions {
  selected: readonly SceneElement[];
  viewport: Viewport;
  theme: Theme;
  selectionBox: Bounds | null;
  bindingTarget: SceneElement | null;
  pathStart: Point | null;
  width: number;
  height: number;
}

const ACCENT = { light: "#007f78", dark: "#5ad6c8" };
const WARM = { light: "#b65b24", dark: "#f3ad73" };
const SURFACE = { light: "#ffffff", dark: "#223533" };

const toScreen = (p: Point, v: Viewport): Point => ({
  x: (p.x + v.scrollX) * v.zoom,
  y: (p.y + v.scrollY) * v.zoom,
});

const polygon = (ctx: CanvasRenderingContext2D, pts: Point[]) => {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
};

/** Draws editor-only controls in screen space on top of the artwork. */
export const renderOverlay = (ctx: CanvasRenderingContext2D, o: OverlayOptions) => {
  const v = o.viewport;
  const accent = ACCENT[o.theme];
  ctx.save();
  ctx.lineWidth = 1;

  if (o.bindingTarget) {
    ctx.strokeStyle = WARM[o.theme];
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    polygon(
      ctx,
      paddedBoxCorners(o.bindingTarget, v.zoom).map((p) => toScreen(p, v)),
    );
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  if (o.selected.length > 1) {
    ctx.strokeStyle = accent;
    ctx.setLineDash([3, 3]);
    for (const el of o.selected) {
      polygon(
        ctx,
        getCorners(el).map((p) => toScreen(p, v)),
      );
      ctx.stroke();
    }
  }

  const box = getTransformBox(o.selected);
  if (box) {
    if (usesEndpointHandlesOnly(o.selected)) {
      const el = o.selected[0];
      drawEndpointHandles(ctx, el, v, accent, SURFACE[o.theme]);
    } else {
      ctx.strokeStyle = accent;
      ctx.setLineDash(o.selected.length > 1 ? [6, 4] : []);
      ctx.lineWidth = 1.5;
      const corners = paddedBoxCorners(box, v.zoom).map((p) => toScreen(p, v));
      polygon(ctx, corners);
      ctx.stroke();
      ctx.setLineDash([]);
      const layout = getHandleLayout(box, v.zoom);
      const top = toScreen(
        { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 },
        { scrollX: 0, scrollY: 0, zoom: 1 },
      );
      const rot = toScreen(layout.rotate, v);
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(rot.x, rot.y);
      ctx.stroke();
      ctx.fillStyle = SURFACE[o.theme];
      ctx.lineWidth = 1.5;
      const s = HANDLE_SIZE;
      for (const pos of Object.values(layout.handles)) {
        const sp = toScreen(pos!, v);
        ctx.beginPath();
        ctx.roundRect(sp.x - s / 2, sp.y - s / 2, s, s, 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(rot.x, rot.y, s / 2 + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (o.selected.length === 1 && isLinear(o.selected[0])) {
        drawEndpointHandles(ctx, o.selected[0], v, accent, SURFACE[o.theme]);
      }
    }
  }

  if (o.selectionBox) {
    const a = toScreen({ x: o.selectionBox.minX, y: o.selectionBox.minY }, v);
    const b = toScreen({ x: o.selectionBox.maxX, y: o.selectionBox.maxY }, v);
    ctx.fillStyle = o.theme === "dark" ? "rgba(90,214,200,0.12)" : "rgba(0,127,120,0.08)";
    ctx.strokeStyle = accent;
    ctx.setLineDash([5, 4]);
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }

  if (o.pathStart) {
    const sp = toScreen(o.pathStart, v);
    ctx.setLineDash([]);
    ctx.strokeStyle = WARM[o.theme];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 10, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
};

const drawEndpointHandles = (
  ctx: CanvasRenderingContext2D,
  el: SceneElement,
  v: Viewport,
  accent: string,
  surface: string,
) => {
  if (!isLinear(el)) return;
  const pts = getAbsolutePoints(el);
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = accent;
  pts.forEach((p, i) => {
    const sp = toScreen(p, v);
    const isEnd = i === 0 || i === pts.length - 1;
    const bound = (i === 0 && el.startBinding) || (i === pts.length - 1 && el.endBinding);
    ctx.fillStyle = bound ? accent : surface;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, isEnd ? HANDLE_SIZE / 2 + 1 : 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
};
