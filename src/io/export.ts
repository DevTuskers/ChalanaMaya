import { PAPER } from "../scene/constants";
import { getCommonBounds } from "../scene/geometry";
import type { FileMap, SceneElement, Theme } from "../scene/types";
import { loadImages, renderScene } from "../render/renderScene";

export interface PngExportOptions {
  background: boolean;
  scale: number;
  theme: Theme;
  padding?: number;
  /** Paper colour to use when `background` is on. */
  backgroundColor?: string;
}

export const MAX_EXPORT_SIDE = 16384;

/** Pixel size of an export, or null when there is nothing to export. */
export const exportSize = (elements: readonly SceneElement[], scale: number, padding = 24) => {
  const b = getCommonBounds(elements);
  if (!b) return null;
  return {
    bounds: b,
    width: Math.ceil((b.maxX - b.minX + padding * 2) * scale),
    height: Math.ceil((b.maxY - b.minY + padding * 2) * scale),
  };
};

/** Renders artwork (no editor controls) to a new canvas. */
export const exportToCanvas = async (
  elements: readonly SceneElement[],
  files: FileMap,
  opts: PngExportOptions,
): Promise<HTMLCanvasElement> => {
  const padding = opts.padding ?? 24;
  const size = exportSize(elements, opts.scale, padding);
  if (!size) throw new Error("There is nothing to export yet.");
  if (size.width > MAX_EXPORT_SIDE || size.height > MAX_EXPORT_SIDE) {
    throw new Error("The image would be too large. Try a smaller scale.");
  }
  await loadImages(elements, files);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser could not create an image.");
  ctx.scale(opts.scale, opts.scale);
  renderScene(ctx, {
    elements,
    files,
    theme: opts.theme,
    background: opts.background ? (opts.backgroundColor ?? PAPER[opts.theme]) : null,
    width: size.width / opts.scale,
    height: size.height / opts.scale,
    still: true,
    viewport: {
      zoom: 1,
      scrollX: -size.bounds.minX + padding,
      scrollY: -size.bounds.minY + padding,
    },
  });
  return canvas;
};

export const canvasToBlob = (canvas: HTMLCanvasElement, type = "image/png") =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("The image could not be encoded."))),
      type,
    ),
  );

export const downloadBlob = (blob: Blob, fileName: string, doc: Document = document) => {
  const win = doc.defaultView ?? window;
  const url = win.URL.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = fileName;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
};

export const timestampName = (ext: string, d = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `board-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
};
