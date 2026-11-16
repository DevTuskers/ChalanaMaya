import type { Drawable } from "roughjs/bin/core";
import { FONT_FAMILIES } from "../scene/constants";
import { getCenter } from "../scene/geometry";
import { getTextLines, lineHeightPx } from "../scene/text";
import type { FileMap, SceneElement, TextElement, Theme } from "../scene/types";
import { paintOrder, textInk } from "../render/renderScene";
import { buildDrawables, dashFor, freedrawOutline, generator, outlineToSvgPath, resolveColor } from "../render/shapes";
import { exportSize } from "./export";

export interface SvgExportOptions {
  theme: Theme;
  /** Background colour, or null for transparent. */
  background: string | null;
  padding?: number;
  /** Extra markup placed first inside the svg (e.g. embedded scene metadata). */
  metadata?: string;
  /** @font-face rules (with data URLs) so text looks the same elsewhere. */
  fontCss?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const n = (v: number) => (Math.round(v * 100) / 100).toString();

const drawableToSvg = (d: Drawable, dash: number[] | undefined) => {
  const o = d.options;
  return d.sets
    .map((set) => {
      const path = generator.opsToPath(set, 2);
      if (set.type === "path") {
        const da = dash ? ` stroke-dasharray="${dash.map(n).join(" ")}"` : "";
        return `<path d="${path}" stroke="${o.stroke}" stroke-width="${n(o.strokeWidth)}" fill="none" stroke-linecap="round"${da}/>`;
      }
      if (set.type === "fillPath") return `<path d="${path}" fill="${o.fill}" stroke="none"/>`;
      return `<path d="${path}" stroke="${o.fill}" stroke-width="${n(o.fillWeight)}" fill="none"/>`;
    })
    .join("");
};

const textSvg = (el: TextElement, theme: Theme, onNote: boolean) => {
  const lines = getTextLines(el);
  const lh = lineHeightPx(el.fontSize);
  const x = el.textAlign === "left" ? -el.width / 2 : el.textAlign === "right" ? el.width / 2 : 0;
  const anchor = el.textAlign === "left" ? "start" : el.textAlign === "right" ? "end" : "middle";
  const family = esc(FONT_FAMILIES[el.fontFamily].css);
  return lines
    .map(
      (line, i) =>
        `<text x="${n(x)}" y="${n(-el.height / 2 + (i + 0.5) * lh)}" font-family="${family}" font-size="${n(el.fontSize)}" fill="${textInk(el, theme, onNote)}" text-anchor="${anchor}" dominant-baseline="central" xml:space="preserve">${esc(line)}</text>`,
    )
    .join("");
};

const elementSvg = (el: SceneElement, files: FileMap, theme: Theme, onNote: boolean): string => {
  const c = getCenter(el);
  const rot = el.angle ? ` rotate(${n((el.angle * 180) / Math.PI)})` : "";
  const op = el.opacity < 100 ? ` opacity="${n(el.opacity / 100)}"` : "";
  let body = "";
  if (el.type === "text") body = textSvg(el, theme, onNote);
  else if (el.type === "freedraw") {
    body = `<path d="${outlineToSvgPath(freedrawOutline(el))}" fill="${resolveColor(el.strokeColor, theme)}"/>`;
  } else if (el.type === "image") {
    const file = files[el.fileId];
    if (file) {
      const flip = el.flipX || el.flipY ? ` transform="scale(${el.flipX ? -1 : 1} ${el.flipY ? -1 : 1})"` : "";
      const cr = el.crop;
      const inner = cr
        ? `<svg x="${n(-el.width / 2)}" y="${n(-el.height / 2)}" width="${n(el.width)}" height="${n(el.height)}" viewBox="${n(cr.x)} ${n(cr.y)} ${n(cr.width)} ${n(cr.height)}" preserveAspectRatio="none"><image width="${n(cr.naturalWidth)}" height="${n(cr.naturalHeight)}" href="${file.dataURL}" preserveAspectRatio="none"/></svg>`
        : `<image x="${n(-el.width / 2)}" y="${n(-el.height / 2)}" width="${n(el.width)}" height="${n(el.height)}" href="${file.dataURL}" preserveAspectRatio="none"/>`;
      body = `<g${flip}>${inner}</g>`;
    }
  } else {
    const dash = dashFor(el);
    body = buildDrawables(el, theme)
      .map((d, i) => drawableToSvg(d, i === 0 ? dash : undefined))
      .join("");
    if (el.type === "frame") {
      body += `<text x="${n(-el.width / 2 + 2)}" y="${n(-el.height / 2 - 5)}" font-family="'Source Sans 3', sans-serif" font-size="13" font-weight="600" fill="${resolveColor(el.strokeColor, theme)}">${esc(el.name)}</text>`;
    }
  }
  return `<g transform="translate(${n(c.x)} ${n(c.y)})${rot}"${op}>${body}</g>`;
};

/** Builds standalone SVG markup for the given elements. */
export const exportToSvg = (
  elements: readonly SceneElement[],
  files: FileMap,
  opts: SvgExportOptions,
): string => {
  const padding = opts.padding ?? 24;
  const size = exportSize(elements, 1, padding);
  if (!size) throw new Error("There is nothing to export yet.");
  const ox = -size.bounds.minX + padding;
  const oy = -size.bounds.minY + padding;
  const notes = new Set(elements.filter((e) => e.type === "note").map((e) => e.id));
  const parts = paintOrder(elements).map((el) =>
    elementSvg(el, files, opts.theme, el.type === "text" && !!el.containerId && notes.has(el.containerId)),
  );
  const bg = opts.background ? `<rect width="100%" height="100%" fill="${opts.background}"/>` : "";
  const style = opts.fontCss ? `<defs><style>${opts.fontCss}</style></defs>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">` +
    (opts.metadata ?? "") +
    style +
    bg +
    `<g transform="translate(${n(ox)} ${n(oy)})">${parts.join("")}</g></svg>`
  );
};

/** Plain text from words, notes and labels, top to bottom. */
export const elementsToPlainText = (elements: readonly SceneElement[]) =>
  elements
    .filter((e): e is TextElement => e.type === "text" && e.text.trim().length > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((t) => t.text)
    .join("\n\n");
