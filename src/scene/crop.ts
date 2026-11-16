import { getCenter, rotatePoint } from "./geometry";
import type { Handle } from "./transform";
import type { Crop, ImageElement, Point } from "./types";

/** The current crop, or the full picture when uncropped. */
export const effectiveCrop = (el: ImageElement, natural: { width: number; height: number }): Crop =>
  el.crop ?? {
    x: 0,
    y: 0,
    width: natural.width,
    height: natural.height,
    naturalWidth: natural.width,
    naturalHeight: natural.height,
  };

/** Board-space box of the whole (uncropped) picture at the current scale, unrotated. */
export const fullImageBox = (el: ImageElement, crop: Crop) => {
  const sx = el.width / crop.width;
  const sy = el.height / crop.height;
  return {
    x: el.x - crop.x * sx,
    y: el.y - crop.y * sy,
    width: crop.naturalWidth * sx,
    height: crop.naturalHeight * sy,
  };
};

const MIN = 8;

/**
 * Drags one crop edge/corner to board point `p`. The picture never stretches: the
 * visible window moves over the original pixels and is clamped to the picture.
 */
export const cropByHandle = (
  el: ImageElement,
  natural: { width: number; height: number },
  handle: Handle,
  p: Point,
): ImageElement => {
  const crop = effectiveCrop(el, natural);
  const full = fullImageBox(el, crop);
  const c = getCenter(el);
  const lp = rotatePoint(p, c, -el.angle);
  let x0 = el.x;
  let y0 = el.y;
  let x1 = el.x + el.width;
  let y1 = el.y + el.height;
  if (handle.includes("w")) x0 = Math.min(Math.max(lp.x, full.x), x1 - MIN);
  if (handle.includes("e")) x1 = Math.max(Math.min(lp.x, full.x + full.width), x0 + MIN);
  if (handle.includes("n")) y0 = Math.min(Math.max(lp.y, full.y), y1 - MIN);
  if (handle.includes("s")) y1 = Math.max(Math.min(lp.y, full.y + full.height), y0 + MIN);
  const sx = crop.width / el.width;
  const sy = crop.height / el.height;
  const next: Crop = {
    ...crop,
    x: (x0 - full.x) * sx,
    y: (y0 - full.y) * sy,
    width: (x1 - x0) * sx,
    height: (y1 - y0) * sy,
  };
  // keep the unrotated box position consistent with the rotation centre
  const localCenter = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  const nc = rotatePoint(localCenter, c, el.angle);
  const w = x1 - x0;
  const h = y1 - y0;
  return { ...el, crop: next, x: nc.x - w / 2, y: nc.y - h / 2, width: w, height: h };
};

/** Shows the whole original picture again at the same scale, centred on the old view. */
export const resetCrop = (el: ImageElement): ImageElement => {
  if (!el.crop) return el;
  const full = fullImageBox(el, el.crop);
  const c = getCenter(el);
  return {
    ...el,
    crop: null,
    x: c.x - full.width / 2,
    y: c.y - full.height / 2,
    width: full.width,
    height: full.height,
  };
};
