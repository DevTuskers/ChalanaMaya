import type { Drawable } from "roughjs/bin/core";
import { isRemote, isVideoFile } from "../render/media";
import { remoteHost } from "../shared/urls";
import { FONT_FAMILIES } from "../scene/constants";
import { getCenter } from "../scene/geometry";
import { getTextLines, lineHeightPx } from "../scene/text";
import type { FileMap, SceneElement, TextElement, Theme } from "../scene/types";
import { paintOrder, textInk } from "../render/renderScene";
import {
  buildDrawables,
  dashFor,
  freedrawOutline,
  generator,
  outlineToSvgPath,
  resolveColor,
} from "../render/shapes";
import { exportSize } from "./export";
import { componentCardSvg } from "../render/componentCard";

export interface SvgExportOptions {
  theme: Theme;
  /** Background colour, or null for transparent. */
  background: string | null;
  padding?: number;
  /** Output size multiplier for width/height; the viewBox stays in board units. */
  scale?: number;
  /** Extra markup placed first inside the svg (e.g. embedded scene metadata). */
  metadata?: string;
  /** @font-face rules (with data URLs) so text looks the same elsewhere. */
  fontCss?: string;
}

/** Escapes a value for use inside a double- or single-quoted XML attribute. */
export const attr = (v: string | number | undefined) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const n = (v: number) => (Math.round(v * 100) / 100).toString();

const drawableToSvg = (d: Drawable, dash: number[] | undefined) => {
  const o = d.options;
  return d.sets
    .map((set) => {
      const path = generator.opsToPath(set, 2);
      if (set.type === "path") {
        const da = dash ? ` stroke-dasharray="${attr(dash.map(n).join(" "))}"` : "";
        return `<path d="${attr(path)}" stroke="${attr(o.stroke)}" stroke-width="${attr(n(o.strokeWidth))}" fill="none" stroke-linecap="round"${da}/>`;
      }
      if (set.type === "fillPath")
        return `<path d="${attr(path)}" fill="${attr(o.fill)}" stroke="none"/>`;
      return `<path d="${attr(path)}" stroke="${attr(o.fill)}" stroke-width="${attr(n(o.fillWeight))}" fill="none"/>`;
    })
    .join("");
};

const textSvg = (el: TextElement, theme: Theme, onNote: boolean) => {
  const lines = getTextLines(el);
  const lh = lineHeightPx(el.fontSize);
  const x = el.textAlign === "left" ? -el.width / 2 : el.textAlign === "right" ? el.width / 2 : 0;
  const anchor = el.textAlign === "left" ? "start" : el.textAlign === "right" ? "end" : "middle";
  const family = FONT_FAMILIES[el.fontFamily].css;
  return lines
    .map(
      (line, i) =>
        `<text x="${attr(n(x))}" y="${attr(n(-el.height / 2 + (i + 0.5) * lh))}" font-family="${attr(family)}" font-size="${attr(n(el.fontSize))}" fill="${attr(textInk(el, theme, onNote))}" text-anchor="${attr(anchor)}" dominant-baseline="central" xml:space="preserve">${esc(line)}</text>`,
    )
    .join("");
};

const elementSvg = (el: SceneElement, files: FileMap, theme: Theme, onNote: boolean): string => {
  const c = getCenter(el);
  const rot = el.angle ? ` rotate(${n((el.angle * 180) / Math.PI)})` : "";
  const op = el.opacity < 100 ? ` opacity="${attr(n(el.opacity / 100))}"` : "";
  let body = "";
  if (el.type === "text") body = textSvg(el, theme, onNote);
  else if (el.type === "freedraw") {
    body = `<path d="${attr(outlineToSvgPath(freedrawOutline(el)))}" fill="${attr(resolveColor(el.strokeColor, theme))}"/>`;
  } else if (el.type === "image") {
    const file = files[el.fileId];
    if (file && (isRemote(file) || isVideoFile(file))) {
      // links and videos can't be put in a still picture: a card stands in (MEDIA-05)
      const stroke = "#8aa7a2";
      const fill = theme === "dark" ? "#1f2a29" : "#eef3f1";
      const ink = theme === "dark" ? "#c8d8d4" : "#3d5753";
      const kind = isVideoFile(file) ? "Video" : file.mimeType === "image/gif" ? "GIF" : "Picture";
      const label = isRemote(file) ? `${kind} · ${remoteHost(file.dataURL)}` : kind;
      body =
        `<rect x="${attr(n(-el.width / 2))}" y="${attr(n(-el.height / 2))}" width="${attr(n(el.width))}" height="${attr(n(el.height))}" fill="${attr(fill)}" stroke="${attr(stroke)}" stroke-dasharray="6 4" data-media-placeholder="1"/>` +
        `<text x="0" y="0" font-family="'Source Sans 3', sans-serif" font-size="13" fill="${attr(ink)}" text-anchor="middle" dominant-baseline="central">${esc(label)}</text>`;
    } else if (file) {
      const flip =
        el.flipX || el.flipY ? ` transform="scale(${el.flipX ? -1 : 1} ${el.flipY ? -1 : 1})"` : "";
      const cr = el.crop;
      const inner = cr
        ? `<svg x="${attr(n(-el.width / 2))}" y="${attr(n(-el.height / 2))}" width="${attr(n(el.width))}" height="${attr(n(el.height))}" viewBox="${n(cr.x)} ${n(cr.y)} ${n(cr.width)} ${n(cr.height)}" preserveAspectRatio="none"><image width="${attr(n(cr.naturalWidth))}" height="${attr(n(cr.naturalHeight))}" href="${attr(file.dataURL)}" preserveAspectRatio="none"/></svg>`
        : `<image x="${attr(n(-el.width / 2))}" y="${attr(n(-el.height / 2))}" width="${attr(n(el.width))}" height="${attr(n(el.height))}" href="${attr(file.dataURL)}" preserveAspectRatio="none"/>`;
      body = `<g${flip}>${inner}</g>`;
    }
  } else if (el.type === "component") {
    // components never run in exports: a static card with the title
    body = componentCardSvg(el, theme);
  } else if (el.type === "embed") {
    // exports show the card with its address; live pages can't be exported
    const stroke = theme === "dark" ? "#4d6b66" : "#9fbdb7";
    const fill = theme === "dark" ? "#223533" : "#ffffff";
    const ink = theme === "dark" ? "#edf8f3" : "#193a36";
    body =
      `<rect x="${attr(n(-el.width / 2))}" y="${attr(n(-el.height / 2))}" width="${attr(n(el.width))}" height="${attr(n(el.height))}" rx="10" fill="${attr(fill)}" stroke="${attr(stroke)}"/>` +
      `<text x="0" y="0" font-family="'Source Sans 3', sans-serif" font-size="14" fill="${attr(ink)}" text-anchor="middle" dominant-baseline="central">${esc(el.url)}</text>`;
  } else {
    const dash = dashFor(el);
    body = buildDrawables(el, theme)
      .map((d, i) => drawableToSvg(d, i === 0 ? dash : undefined))
      .join("");
    if (el.type === "frame") {
      body += `<text x="${attr(n(-el.width / 2 + 2))}" y="${attr(n(-el.height / 2 - 5))}" font-family="'Source Sans 3', sans-serif" font-size="13" font-weight="600" fill="${attr(resolveColor(el.strokeColor, theme))}">${esc(el.name)}</text>`;
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
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 1;
  // same pixel size the export dialog reports
  const out = exportSize(elements, scale, padding)!;
  const ox = -size.bounds.minX + padding;
  const oy = -size.bounds.minY + padding;
  const notes = new Set(elements.filter((e) => e.type === "note").map((e) => e.id));
  const parts = paintOrder(elements).map((el) =>
    elementSvg(
      el,
      files,
      opts.theme,
      el.type === "text" && !!el.containerId && notes.has(el.containerId),
    ),
  );
  const bg = opts.background
    ? `<rect width="100%" height="100%" fill="${attr(opts.background)}"/>`
    : "";
  const style = opts.fontCss ? `<defs><style>${opts.fontCss}</style></defs>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${attr(out.width)}" height="${attr(out.height)}" viewBox="0 0 ${size.width} ${size.height}">` +
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
