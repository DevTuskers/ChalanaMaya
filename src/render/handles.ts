import { getCommonBounds, getCenter, rotatePoint } from "../scene/geometry";
import { isLinear } from "../scene/elements";
import type { Handle } from "../scene/transform";
import type { Point, SceneElement } from "../scene/types";

export const HANDLE_SIZE = 9; // screen px
const PAD = 6; // screen px
const ROTATE_OFFSET = 24; // screen px

export interface TransformBox {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
}

export interface HandleLayout {
  box: TransformBox;
  handles: Partial<Record<Handle, Point>>;
  rotate: Point;
}

/** Box used for transform handles: the element itself, or common bounds for several. */
export const getTransformBox = (selected: readonly SceneElement[]): TransformBox | null => {
  if (!selected.length) return null;
  if (selected.length === 1) {
    const el = selected[0];
    return { x: el.x, y: el.y, width: el.width, height: el.height, angle: el.angle };
  }
  const b = getCommonBounds(selected)!;
  return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, angle: 0 };
};

/** A single straight two-point line/arrow is edited via its endpoints only. */
export const usesEndpointHandlesOnly = (selected: readonly SceneElement[]) =>
  selected.length === 1 && isLinear(selected[0]) && selected[0].points.length === 2;

export const getHandleLayout = (box: TransformBox, zoom: number): HandleLayout => {
  const pad = PAD / zoom;
  const x0 = box.x - pad;
  const y0 = box.y - pad;
  const x1 = box.x + box.width + pad;
  const y1 = box.y + box.height + pad;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const c = getCenter(box);
  const r = (p: Point) => rotatePoint(p, c, box.angle);
  const small = (x1 - x0) * zoom < 36 || (y1 - y0) * zoom < 36;
  const handles: Partial<Record<Handle, Point>> = {
    nw: r({ x: x0, y: y0 }),
    ne: r({ x: x1, y: y0 }),
    se: r({ x: x1, y: y1 }),
    sw: r({ x: x0, y: y1 }),
  };
  if (!small) {
    handles.n = r({ x: cx, y: y0 });
    handles.s = r({ x: cx, y: y1 });
    handles.e = r({ x: x1, y: cy });
    handles.w = r({ x: x0, y: cy });
  }
  return { box, handles, rotate: r({ x: cx, y: y0 - ROTATE_OFFSET / zoom }) };
};

export const paddedBoxCorners = (box: TransformBox, zoom: number): Point[] => {
  const pad = PAD / zoom;
  const c = getCenter(box);
  return [
    { x: box.x - pad, y: box.y - pad },
    { x: box.x + box.width + pad, y: box.y - pad },
    { x: box.x + box.width + pad, y: box.y + box.height + pad },
    { x: box.x - pad, y: box.y + box.height + pad },
  ].map((p) => rotatePoint(p, c, box.angle));
};

export const HANDLE_CURSORS: Record<Handle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};
