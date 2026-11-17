import rough from "roughjs";
import {
  drawMediaPlaceholder,
  isLiveShown,
  isComponentLive,
  getVideo,
  gifFrame,
  isGifFile,
  isRemote,
  isVideoFile,
} from "./media";
import type { Drawable } from "roughjs/bin/core";
import { NOTE_INK } from "../scene/constants";
import { isSessionFilePath } from "../shared/ids";
import { getCenter } from "../scene/geometry";
import { buildDrawables, freedrawOutline, resolveColor } from "./shapes";
import { fontString, getTextLines, lineHeightPx } from "../scene/text";
import { resolveWebCard, WEB_CARD_HEADER } from "../scene/webcard";
import { drawComponentCard } from "./componentCard";
import type {
  EmbedElement,
  FileMap,
  FreedrawElement,
  ImageElement,
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

/** The clock animated GIFs follow (replaced in tests). */
export let mediaNow = () => performance.now();
export const setMediaClock = (fn: () => number) => {
  mediaNow = fn;
};

const imageCache = new Map<string, HTMLImageElement>();
let onImageLoad: () => void = () => {};
export const setImageLoadListener = (fn: () => void) => {
  onImageLoad = fn;
};

/**
 * Only data URLs and same-origin session file paths are drawn (plan §3.10):
 * a remote picture would taint the canvas and break exports.
 */
export const isLoadableImageSrc = (src: string) =>
  src.startsWith("data:") || isSessionFilePath(src);

export const getImage = (fileId: string, files: FileMap): HTMLImageElement | null => {
  const file = files[fileId];
  if (!file || isRemote(file) || isVideoFile(file) || !isLoadableImageSrc(file.dataURL))
    return null;
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
            // remote links are never loaded for a canvas: exports draw a card
            if (!file || isRemote(file)) return resolve();
            if (isVideoFile(file)) {
              // exports take the frame on screen (the first frame for a new video)
              const v = getVideo(e as ImageElement, file);
              if (v.readyState >= 2) return resolve();
              const t = setTimeout(resolve, 3000);
              const done = () => (clearTimeout(t), resolve());
              v.addEventListener("loadeddata", done, { once: true });
              v.addEventListener("error", done, { once: true });
              return;
            }
            getImage(file.id, files);
            const img = imageCache.get(file.id);
            if (!img) return resolve();
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

const drawText = (
  ctx: CanvasRenderingContext2D,
  el: TextElement,
  theme: Theme,
  onNote: boolean,
) => {
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

const WEB_CARD_COLORS = {
  light: {
    surface: "#ffffff",
    header: "#e6f3f0",
    ink: "#193a36",
    soft: "#52706b",
    line: "#9fbdb7",
  },
  dark: { surface: "#223533", header: "#1b2c2a", ink: "#edf8f3", soft: "#a9c7c0", line: "#4d6b66" },
} as const;

/** Canvas face of a web card; the live page is shown on top of it by the web card layer. */
const drawWebCard = (ctx: CanvasRenderingContext2D, el: EmbedElement, theme: Theme) => {
  const c = WEB_CARD_COLORS[theme];
  const w = el.width;
  const h = el.height;
  const x = -w / 2;
  const y = -h / 2;
  const r = Math.min(10, w / 4, h / 4);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = c.surface;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = c.header;
  ctx.fillRect(x, y, w, Math.min(WEB_CARD_HEADER, h));
  ctx.restore();
  ctx.strokeStyle = c.line;
  ctx.lineWidth = 1;
  ctx.stroke();
  const res = resolveWebCard(el.url);
  const title = res.ok
    ? res.target.kind === "embed"
      ? `${res.target.provider} \u00b7 ${new URL(res.target.url).hostname.replace(/^www\./, "")}`
      : res.target.host
    : "Web card";
  ctx.font = `600 13px "Source Sans 3", system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = c.ink;
  if (h >= 18)
    ctx.fillText(title, x + 12, y + Math.min(WEB_CARD_HEADER, h) / 2, Math.max(10, w - 24));
  if (h < WEB_CARD_HEADER + 30) return;
  ctx.font = `14px "Source Sans 3", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = c.soft;
  const msg = !res.ok
    ? "This web address can't be used."
    : res.target.kind === "embed"
      ? "Double-click to use the page"
      : "This site can't be shown here.";
  ctx.fillText(msg, 0, y + WEB_CARD_HEADER + (h - WEB_CARD_HEADER) / 2 - 10, Math.max(10, w - 24));
  ctx.font = `12px "IBM Plex Mono", ui-monospace, monospace`;
  ctx.fillText(
    el.url.length > 60 ? `${el.url.slice(0, 57)}...` : el.url,
    0,
    y + WEB_CARD_HEADER + (h - WEB_CARD_HEADER) / 2 + 12,
    Math.max(10, w - 24),
  );
};

/** A round play badge centred on the item (video stills in PNG exports). */
const drawPlayBadge = (ctx: CanvasRenderingContext2D, r: number) => {
  if (r < 6) return;
  ctx.fillStyle = "rgba(15, 30, 28, 0.6)";
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(-r * 0.35, -r * 0.5);
  ctx.lineTo(r * 0.55, 0);
  ctx.lineTo(-r * 0.35, r * 0.5);
  ctx.closePath();
  ctx.fill();
};

export const drawElement = (
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof rough.canvas>,
  el: SceneElement,
  files: FileMap,
  theme: Theme,
  ctxInfo: { onNote?: boolean; alpha?: number; still?: boolean } = {},
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
    const file = files[el.fileId];
    let img: CanvasImageSource | null = null;
    let nat = { w: 0, h: 0 };
    if (file && isRemote(file)) {
      // links are shown by the live layer; the canvas and exports get a card
      // (nothing on the board once the live item has loaded over it)
      if (ctxInfo.still || !isLiveShown(el, file)) drawMediaPlaceholder(ctx, el, file, theme);
    } else if (isVideoFile(file)) {
      const v = getVideo(el, file!);
      if (v.readyState >= 2 && v.videoWidth) {
        img = v;
        nat = { w: v.videoWidth, h: v.videoHeight };
      } else drawMediaPlaceholder(ctx, el, file, theme);
    } else {
      const still = getImage(el.fileId, files);
      if (still) {
        nat = { w: still.naturalWidth, h: still.naturalHeight };
        // a PNG export shows a GIF's first frame (MEDIA-07)
        img = (!ctxInfo.still && isGifFile(file) && gifFrame(el, file!, mediaNow())) || still;
      }
    }
    if (img) {
      if (el.flipX || el.flipY) ctx.scale(el.flipX ? -1 : 1, el.flipY ? -1 : 1);
      const cr = el.crop;
      if (cr) {
        const kx = nat.w / cr.naturalWidth;
        const ky = nat.h / cr.naturalHeight;
        ctx.drawImage(
          img,
          cr.x * kx,
          cr.y * ky,
          cr.width * kx,
          cr.height * ky,
          -el.width / 2,
          -el.height / 2,
          el.width,
          el.height,
        );
      } else ctx.drawImage(img, -el.width / 2, -el.height / 2, el.width, el.height);
      if (ctxInfo.still && isVideoFile(file)) {
        if (el.flipX || el.flipY) ctx.scale(el.flipX ? -1 : 1, el.flipY ? -1 : 1);
        drawPlayBadge(ctx, Math.min(28, el.width / 5, el.height / 5));
      }
    } else if (!file || !(isRemote(file) || isVideoFile(file))) {
      ctx.strokeStyle = "#8aa7a2";
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(-el.width / 2, -el.height / 2, el.width, el.height);
    }
  } else if (el.type === "embed") {
    drawWebCard(ctx, el, theme);
  } else if (el.type === "component") {
    // the live frame covers it on the board; exports always draw the card
    if (ctxInfo.still || !isComponentLive(el.id)) drawComponentCard(ctx, el, theme);
  } else {
    for (const d of getDrawables(el, theme)) rc.draw(d);
    if (el.type === "frame") {
      ctx.font = `600 13px "Source Sans 3", system-ui, sans-serif`;
      ctx.fillStyle = resolveColor(el.strokeColor, theme);
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(
        el.name || "Page",
        -el.width / 2 + 2,
        -el.height / 2 - 5,
        Math.max(40, el.width),
      );
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
  /** Grid colour; when set a view-only grid is drawn under the artwork. */
  grid?: string | null;
  /**
   * Partial redraw (plan §6.3): repaint only this screen rectangle, drawing
   * just the items that reach into it. Used for animation frames.
   */
  clip?: readonly { x: number; y: number; width: number; height: number }[] | null;
  /** Paint over what the canvas already shows (no clear, no background). */
  keep?: boolean;
  /** A still picture (PNG export): videos get a play badge (MEDIA-07). */
  still?: boolean;
}

export const GRID_SIZE = 20;

/** Board-aligned grid lines (a view aid, never part of the artwork). */
export const drawGrid = (
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  width: number,
  height: number,
  color: string,
) => {
  let step = GRID_SIZE * v.zoom;
  while (step < 8) step *= 5;
  const major = step * 5;
  const offX = (v.scrollX * v.zoom) % major;
  const offY = (v.scrollY * v.zoom) % major;
  ctx.save();
  ctx.strokeStyle = color;
  for (const [s, alpha] of [
    [step, 0.45],
    [major, 1],
  ] as const) {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = offX % s; x < width; x += s) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, height);
    }
    for (let y = offY % s; y < height; y += s) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }
  ctx.restore();
};

/** Draws artwork only (no editor controls). The context must already be DPR-scaled. */
export const renderScene = (ctx: CanvasRenderingContext2D, opts: RenderOptions) => {
  const { viewport: v } = opts;
  ctx.save();
  const clips = opts.clip?.length ? opts.clip : null;
  if (clips) {
    ctx.beginPath();
    for (const c of clips) ctx.rect(c.x, c.y, c.width, c.height);
    ctx.clip();
    for (const c of clips) ctx.clearRect(c.x, c.y, c.width, c.height);
  } else if (!opts.keep) ctx.clearRect(0, 0, opts.width, opts.height);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, opts.width, opts.height);
  }
  if (opts.grid) drawGrid(ctx, v, opts.width, opts.height, opts.grid);
  ctx.scale(v.zoom, v.zoom);
  ctx.translate(v.scrollX, v.scrollY);
  const rc = rough.canvas(ctx.canvas);
  const minX = -v.scrollX;
  const minY = -v.scrollY;
  const maxX = minX + opts.width / v.zoom;
  const maxY = minY + opts.height / v.zoom;
  // world rectangles of a partial redraw
  const worldClips = clips?.map((c) => ({
    minX: c.x / v.zoom - v.scrollX,
    minY: c.y / v.zoom - v.scrollY,
    maxX: (c.x + c.width) / v.zoom - v.scrollX,
    maxY: (c.y + c.height) / v.zoom - v.scrollY,
  }));
  const notes = new Set(opts.elements.filter((e) => e.type === "note").map((e) => e.id));
  const linear = new Set(
    opts.elements.filter((e) => e.type === "arrow" || e.type === "line").map((e) => e.id),
  );
  for (const el of paintOrder(opts.elements)) {
    if (opts.skipIds?.has(el.id)) continue;
    // cheap culling with a generous margin for rotation and stroke
    const r = Math.hypot(el.width, el.height) / 2 + 40;
    const c = getCenter(el);
    if (c.x + r < minX || c.x - r > maxX || c.y + r < minY || c.y - r > maxY) continue;
    if (
      worldClips &&
      !worldClips.some(
        (w) => c.x + r >= w.minX && c.x - r <= w.maxX && c.y + r >= w.minY && c.y - r <= w.maxY,
      )
    )
      continue;
    if (el.type === "text" && el.containerId && linear.has(el.containerId) && opts.background) {
      // knock the connector line out behind its label so the words stay readable
      ctx.fillStyle = opts.background;
      ctx.fillRect(el.x - 4, el.y - 2, el.width + 8, el.height + 4);
    }
    drawElement(ctx, rc, el, opts.files, opts.theme, {
      onNote: el.type === "text" && !!el.containerId && notes.has(el.containerId),
      alpha: opts.fadeIds?.has(el.id) ? 0.3 : 1,
      still: opts.still,
    });
  }
  ctx.restore();
};
