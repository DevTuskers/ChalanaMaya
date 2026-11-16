import rough from "roughjs";
import type { Drawable, Options } from "roughjs/bin/core";
import { getStroke } from "perfect-freehand";
import { INK, INK_DARK, TRANSPARENT } from "../scene/constants";
import { getCenter } from "../scene/geometry";
import { fontString, getTextLines, lineHeightPx } from "../scene/text";
import type {
  FileMap,
  FreedrawElement,
  Point,
  SceneElement,
  TextElement,
  Theme,
  Viewport,
} from "../scene/types";

const generator = rough.generator();

/** The default ink adapts to the theme; explicit colours are never changed. */
/**
 * Dark-theme display variants of the built-in stroke palette. Stored colours never change;
 * only how palette inks are drawn on the dark paper, so artwork stays readable.
 */
const DARK_INKS: Record<string, string> = {
  [INK]: INK_DARK,
  "#007f78": "#5ad6c8",
  "#b65b24": "#f3ad73",
  "#c0392b": "#ff8a7a",
  "#2f6fb5": "#86b8f0",
  "#6b8e23": "#a9cc5e",
};

export const resolveColor = (color: string, theme: Theme) =>
  theme === "dark" ? (DARK_INKS[color.toLowerCase()] ?? color) : color;

const roughOptions = (el: SceneElement, theme: Theme, fill: boolean): Options => ({
  seed: el.seed,
  stroke: resolveColor(el.strokeColor, theme),
  strokeWidth: el.strokeWidth,
  roughness: 1,
  bowing: 1,
  fill: fill && el.backgroundColor !== TRANSPARENT ? el.backgroundColor : undefined,
  fillStyle: el.fillStyle,
  fillWeight: Math.max(0.5, el.strokeWidth / 2),
  hachureGap: 4 + el.strokeWidth * 1.5,
  preserveVertices: true,
});

const cache = new WeakMap<SceneElement, { theme: Theme; drawables: Drawable[] }>();

const arrowhead = (pts: Point[], size: number): [Point, Point, Point] | null => {
  const end = pts[pts.length - 1];
  let prev = pts[pts.length - 2];
  for (let i = pts.length - 2; i >= 0 && Math.hypot(end.x - prev.x, end.y - prev.y) < 1; i--) {
    prev = pts[i];
  }
  const len = Math.hypot(end.x - prev.x, end.y - prev.y);
  if (len < 1) return null;
  const s = Math.min(size, len * 0.6);
  const a = Math.atan2(end.y - prev.y, end.x - prev.x);
  const spread = Math.PI / 7;
  return [
    { x: end.x - s * Math.cos(a - spread), y: end.y - s * Math.sin(a - spread) },
    end,
    { x: end.x - s * Math.cos(a + spread), y: end.y - s * Math.sin(a + spread) },
  ];
};

const buildDrawables = (el: SceneElement, theme: Theme): Drawable[] => {
  const w = el.width;
  const h = el.height;
  const ox = -w / 2;
  const oy = -h / 2;
  switch (el.type) {
    case "rectangle":
      return [generator.rectangle(ox, oy, w, h, roughOptions(el, theme, true))];
    case "diamond":
      return [
        generator.polygon(
          [
            [0, oy],
            [-ox, 0],
            [0, -oy],
            [ox, 0],
          ],
          roughOptions(el, theme, true),
        ),
      ];
    case "ellipse":
      return [generator.ellipse(0, 0, w, h, roughOptions(el, theme, true))];
    case "line":
    case "arrow": {
      const pts = el.points.map((p) => ({ x: p.x + ox, y: p.y + oy }));
      const tuples = pts.map((p) => [p.x, p.y] as [number, number]);
      if (pts.length < 2) return [];
      if (el.type === "line" && el.closed) {
        return [generator.polygon(tuples, roughOptions(el, theme, true))];
      }
      const out = [generator.linearPath(tuples, roughOptions(el, theme, false))];
      if (el.type === "arrow") {
        const head = arrowhead(pts, 14 + el.strokeWidth * 3);
        if (head) {
          out.push(
            generator.linearPath(
              head.map((p) => [p.x, p.y] as [number, number]),
              roughOptions(el, theme, false),
            ),
          );
        }
      }
      return out;
    }
    default:
      return [];
  }
};

const getDrawables = (el: SceneElement, theme: Theme) => {
  const hit = cache.get(el);
  if (hit && hit.theme === theme) return hit.drawables;
  const drawables = buildDrawables(el, theme);
  cache.set(el, { theme, drawables });
  return drawables;
};

const freedrawPath = (el: FreedrawElement): Path2D => {
  const ox = -el.width / 2;
  const oy = -el.height / 2;
  const outline = getStroke(
    el.points.map((p) => [p.x + ox, p.y + oy]),
    {
      size: el.strokeWidth * 3 + 2,
      thinning: 0.55,
      smoothing: 0.5,
      streamline: 0.45,
      simulatePressure: true,
    },
  );
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

const drawText = (ctx: CanvasRenderingContext2D, el: TextElement, theme: Theme) => {
  const lines = getTextLines(el);
  const lh = lineHeightPx(el.fontSize);
  ctx.font = fontString(el.fontFamily, el.fontSize);
  ctx.fillStyle = resolveColor(el.strokeColor, theme);
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
) => {
  const c = getCenter(el);
  ctx.save();
  ctx.translate(c.x, c.y);
  if (el.angle) ctx.rotate(el.angle);
  if (el.type === "text") drawText(ctx, el, theme);
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
    if (img) ctx.drawImage(img, -el.width / 2, -el.height / 2, el.width, el.height);
    else {
      ctx.strokeStyle = "#8aa7a2";
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(-el.width / 2, -el.height / 2, el.width, el.height);
    }
  } else {
    for (const d of getDrawables(el, theme)) rc.draw(d);
  }
  ctx.restore();
};

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
  for (const el of opts.elements) {
    if (opts.skipIds?.has(el.id)) continue;
    // cheap culling with a generous margin for rotation and stroke
    const r = Math.hypot(el.width, el.height) / 2 + 40;
    const c = getCenter(el);
    if (c.x + r < minX || c.x - r > maxX || c.y + r < minY || c.y - r > maxY) continue;
    drawElement(ctx, rc, el, opts.files, opts.theme);
  }
  ctx.restore();
};
