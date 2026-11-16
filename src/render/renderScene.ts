import rough from "roughjs";
import type { Drawable } from "roughjs/bin/core";
import { NOTE_INK } from "../scene/constants";
import { getCenter } from "../scene/geometry";
import { buildDrawables, freedrawOutline, resolveColor } from "./shapes";
import { fontString, getTextLines, lineHeightPx } from "../scene/text";
import type {
  FileMap,
  FreedrawElement,
  SceneElement,
  TextElement,
  Theme,
  Viewport,
} from "../scene/types";

export { resolveColor };

const cache = new WeakMap<SceneElement, { theme: Theme; drawables: Drawable[] }>();

const getDrawables = (el: SceneElement, theme: Theme) => {
  const hit = cache.get(el);
  if (hit && hit.theme === theme) return hit.drawables;
  const drawables = buildDrawables(el, theme);
  cache.set(el, { theme, drawables });
  return drawables;
};

const freedrawPath = (el: FreedrawElement): Path2D => {
  const outline = freedrawOutline(el);
  const path = new Path2D();
  if (!outline.length) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1];
    const [x1, y1] = outline[i];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
};
const pathCache = new WeakMap<FreedrawElement, Path2D>();

const imageCache = new Map<string, HTMLImageElement>();
let onImageLoad: () => void = () => {};
export const setImageLoadListener = (fn: () => void) => {
  onImageLoad = fn;
};

export const getImage = (fileId: string, files: FileMap): HTMLImageElement | null => {
  const file = files[fileId];
  if (!file) return null;
  let img = imageCache.get(fileId);
  if (!img || img.dataset.src !== file.dataURL.slice(0, 64) + file.dataURL.length) {
    img = new Image();
    img.dataset.src = file.dataURL.slice(0, 64) + file.dataURL.length;
    img.onload = () => onImageLoad();
    img.src = file.dataURL;
    imageCache.set(fileId, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
};

/** Pre-loads images so exports can wait for them. */
export const loadImages = async (elements: readonly SceneElement[], files: FileMap) => {
  await Promise.all(
    elements
      .filter((e) => e.type === "image")
      .map(
        (e) =>
          new Promise<void>((resolve) => {
            const file = files[(e as { fileId: string }).fileId];
            if (!file) return resolve();
            getImage(file.id, files);
            const img = imageCache.get(file.id)!;
            if (img.complete) return resolve();
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          }),
      ),
  );
};

/** Text on a note keeps its stored ink: notes are light paper in both themes. */
export const textInk = (el: TextElement, theme: Theme, onNote: boolean) =>
  onNote ? el.strokeColor || NOTE_INK : resolveColor(el.strokeColor, theme);

const drawText = (ctx: CanvasRenderingContext2D, el: TextElement, theme: Theme, onNote: boolean) => {
  const lines = getTextLines(el);
  const lh = lineHeightPx(el.fontSize);
  ctx.font = fontString(el.fontFamily, el.fontSize);
  ctx.fillStyle = textInk(el, theme, onNote);
  ctx.textAlign = el.textAlign;
  ctx.textBaseline = "middle";
  const x = el.textAlign === "left" ? -el.width / 2 : el.textAlign === "right" ? el.width / 2 : 0;
  const top = -el.height / 2;
  lines.forEach((line, i) => ctx.fillText(line, x, top + (i + 0.5) * lh));
};

export const drawElement = (
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof rough.canvas>,
  el: SceneElement,
  files: FileMap,
  theme: Theme,
  ctxInfo: { onNote?: boolean; alpha?: number } = {},
) => {
  const c = getCenter(el);
  ctx.save();
  ctx.globalAlpha = (el.opacity / 100) * (ctxInfo.alpha ?? 1);
  ctx.translate(c.x, c.y);
  if (el.angle) ctx.rotate(el.angle);
  if (el.type === "text") drawText(ctx, el, theme, !!ctxInfo.onNote);
  else if (el.type === "freedraw") {
    let path = pathCache.get(el);
    if (!path) {
      path = freedrawPath(el);
      pathCache.set(el, path);
    }
    ctx.fillStyle = resolveColor(el.strokeColor, theme);
    ctx.fill(path);
  } else if (el.type === "image") {
    const img = getImage(el.fileId, files);
    if (img) {
      if (el.flipX || el.flipY) ctx.scale(el.flipX ? -1 : 1, el.flipY ? -1 : 1);
      const cr = el.crop;
      if (cr) {
        const kx = img.naturalWidth / cr.naturalWidth;
        const ky = img.naturalHeight / cr.naturalHeight;
        ctx.drawImage(img, cr.x * kx, cr.y * ky, cr.width * kx, cr.height * ky, -el.width / 2, -el.height / 2, el.width, el.height);
      } else ctx.drawImage(img, -el.width / 2, -el.height / 2, el.width, el.height);
    } else {
      ctx.strokeStyle = "#8aa7a2";
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(-el.width / 2, -el.height / 2, el.width, el.height);
    }
  } else {
    for (const d of getDrawables(el, theme)) rc.draw(d);
    if (el.type === "frame") {
      ctx.font = `600 13px "Source Sans 3", system-ui, sans-serif`;
      ctx.fillStyle = resolveColor(el.strokeColor, theme);
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(el.name || "Page", -el.width / 2 + 2, -el.height / 2 - 5, Math.max(40, el.width));
    }
  }
  ctx.restore();
};

/** Frames are always painted below everything else. */
export const paintOrder = (elements: readonly SceneElement[]) => [
  ...elements.filter((e) => e.type === "frame"),
  ...elements.filter((e) => e.type !== "frame"),
];

export interface RenderOptions {
  elements: readonly SceneElement[];
  files: FileMap;
  viewport: Viewport;
  theme: Theme;
  /** Fill colour for the canvas, or null for a transparent background. */
  background: string | null;
  width: number;
  height: number;
  skipIds?: ReadonlySet<string>;
  /** Drawn faded (e.g. about to be erased). */
  fadeIds?: ReadonlySet<string>;
}

/** Draws artwork only (no editor controls). The context must already be DPR-scaled. */
export const renderScene = (ctx: CanvasRenderingContext2D, opts: RenderOptions) => {
  const { viewport: v } = opts;
  ctx.save();
  ctx.clearRect(0, 0, opts.width, opts.height);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, opts.width, opts.height);
  }
  ctx.scale(v.zoom, v.zoom);
  ctx.translate(v.scrollX, v.scrollY);
  const rc = rough.canvas(ctx.canvas);
  const minX = -v.scrollX;
  const minY = -v.scrollY;
  const maxX = minX + opts.width / v.zoom;
  const maxY = minY + opts.height / v.zoom;
  const notes = new Set(opts.elements.filter((e) => e.type === "note").map((e) => e.id));
  for (const el of paintOrder(opts.elements)) {
    if (opts.skipIds?.has(el.id)) continue;
    // cheap culling with a generous margin for rotation and stroke
    const r = Math.hypot(el.width, el.height) / 2 + 40;
    const c = getCenter(el);
    if (c.x + r < minX || c.x - r > maxX || c.y + r < minY || c.y - r > maxY) continue;
    drawElement(ctx, rc, el, opts.files, opts.theme, {
      onNote: el.type === "text" && !!el.containerId && notes.has(el.containerId),
      alpha: opts.fadeIds?.has(el.id) ? 0.3 : 1,
    });
  }
  ctx.restore();
};
