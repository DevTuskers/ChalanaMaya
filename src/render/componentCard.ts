/**
 * The static card for an animated component (MEDIA-05/06): drawn on the board
 * under the live frame, while it is not live (too small, too many, zoomed
 * out), and in PNG/SVG exports, which never run components. Each preset gets
 * a simple still picture of itself (one frame of its animation) above the
 * title; custom components show the title only.
 *
 * The still is a short list of primitives drawn by both the canvas and the
 * SVG writer, so PNG and SVG exports show the same picture.
 */
import type { ComponentElement } from "../scene/types";
import { PRESET_SURFACES, presetByName, presetValues } from "../shared/components";
import { resolveColor } from "./shapes";

type Theme = "light" | "dark";

const COLORS = {
  light: { surface: "#ffffff", line: "#9fbdb7", ink: "#193a36", soft: "#52706b" },
  dark: { surface: "#223533", line: "#4d6b66", ink: "#edf8f3", soft: "#a9c7c0" },
} as const;

export const COMPONENT_CARD_LABEL = "Animated component";

export const componentCardTitle = (el: ComponentElement) => {
  if (el.title.trim()) return el.title.trim();
  if (el.source.kind === "preset") return presetByName(el.source.preset)?.title ?? "Component";
  return "Custom component";
};

/** The accent colour of a preset's still (as stored), or null for custom components. */
export const componentAccent = (el: ComponentElement): string | null => {
  if (el.source.kind !== "preset") return null;
  const def = presetByName(el.source.preset);
  if (!def) return null;
  const v = presetValues(def, el.source.params);
  const c = v.color ?? v.from;
  return typeof c === "string" ? c : "#007f78";
};

export type StillPrim =
  | { k: "circle"; cx: number; cy: number; r: number; fill?: string; stroke?: string; sw?: number }
  | { k: "rect"; x: number; y: number; w: number; h: number; r: number; fill: string }
  | { k: "grad"; x: number; y: number; w: number; h: number; r: number; stops: string[] }
  | { k: "poly"; pts: [number, number][]; stroke: string; sw: number }
  | { k: "text"; x: number; y: number; text: string; size: number; fill: string };

interface Layout {
  /** picture box centre and size, or null when there is no room */
  pic: { cx: number; cy: number; w: number; h: number } | null;
  /** y of the title line, or null when the card is too small for text */
  titleY: number | null;
  label: boolean;
}

const layout = (el: ComponentElement): Layout => {
  const w = el.width;
  const h = el.height;
  const text = h >= 30 && w >= 50;
  const label = h >= 56;
  const isPreset = el.source.kind === "preset";
  if (!isPreset) return { pic: null, titleY: text ? (label ? -9 : 0) : null, label };
  const block = text ? (label ? 40 : 22) : 0;
  const top = -h / 2 + 6;
  const bottom = h / 2 - 6 - block;
  const ph = bottom - top;
  const pic = ph >= 10 && w >= 20 ? { cx: 0, cy: (top + bottom) / 2, w: w - 16, h: ph } : null;
  // when there is no room for a picture the text sits in the middle
  const titleY = !text ? null : pic ? bottom + 11 : label ? -9 : 0;
  return { pic, titleY, label };
};

const arc = (cx: number, cy: number, r: number, a0: number, a1: number): [number, number][] => {
  const out: [number, number][] = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
};

/** The still picture of a preset inside its picture box. */
export const componentStill = (el: ComponentElement, theme: Theme): StillPrim[] => {
  if (el.source.kind !== "preset") return [];
  const def = presetByName(el.source.preset);
  const box = layout(el).pic;
  if (!def || !box) return [];
  const v = presetValues(def, el.source.params);
  const surf = PRESET_SURFACES[theme];
  const col = (name: string) => resolveColor(String(v[name] ?? "#007f78"), theme);
  const { cx, cy, w, h } = box;
  const s = Math.min(w, h);
  switch (def.name) {
    case "pulse":
      return [
        { k: "circle", cx, cy, r: s * 0.4, stroke: col("color"), sw: Math.max(1.5, s * 0.04) },
        { k: "circle", cx, cy, r: s * 0.22, fill: col("color") },
      ];
    case "spinner": {
      const r = s * 0.36;
      const sw = Math.max(2, s * 0.09);
      return [
        { k: "circle", cx, cy, r, stroke: `${col("color")}33`, sw },
        { k: "poly", pts: arc(cx, cy, r, -Math.PI / 2, Math.PI / 6), stroke: col("color"), sw },
      ];
    }
    case "typing-dots": {
      const r = Math.min(w / 10, h / 4);
      const gap = r * 3;
      return [-1, 0, 1].map((i) => ({
        k: "circle" as const,
        cx: cx + i * gap,
        cy: cy - (i === 0 ? r * 0.7 : 0),
        r,
        fill: col("color"),
      }));
    }
    case "progress-bar": {
      const bw = w * 0.9;
      const bh = Math.min(14, h / 2);
      const x = cx - bw / 2;
      const label = String(v.label ?? "");
      const out: StillPrim[] = [];
      let by = cy - bh / 2;
      if (label && h >= bh + 18) {
        by = cy + h / 2 - bh;
        out.push({ k: "text", x, y: by - 10, text: label, size: 12, fill: surf.ink });
      }
      out.push({ k: "rect", x, y: by, w: bw, h: bh, r: bh / 2, fill: surf.track });
      const fw = (bw * Number(v.value ?? 0)) / 100;
      if (fw > 0)
        out.push({
          k: "rect",
          x,
          y: by,
          w: fw,
          h: bh,
          r: Math.min(bh / 2, fw / 2),
          fill: col("color"),
        });
      return out;
    }
    case "shimmer-card": {
      const cw = w * 0.9;
      const ch = h * 0.92;
      const x = cx - cw / 2;
      const y = cy - ch / 2;
      const out: StillPrim[] = [
        { k: "rect", x, y, w: cw, h: ch, r: Math.min(10, ch / 4), fill: surf.card },
      ];
      const lines = Math.round(Number(v.lines ?? 3)) + 1;
      const pad = Math.min(12, cw * 0.06);
      const lh = Math.min(10, (ch - pad * 2) / (lines * 1.8));
      if (lh >= 2)
        for (let i = 0; i < lines; i++) {
          const lw = (cw - pad * 2) * (i === 0 ? 0.45 : i === lines - 1 ? 0.7 : 1);
          out.push({
            k: "rect",
            x: x + pad,
            y: y + pad + i * lh * 1.8,
            w: lw,
            h: lh,
            r: lh / 2,
            fill: i === 1 ? surf.sheen : surf.line,
          });
        }
      return out;
    }
    case "marquee": {
      const size = Math.max(8, Math.min(18, h * 0.6));
      const max = Math.max(1, Math.floor(w / (size * 0.55)));
      const t = String(v.text ?? "");
      const text = t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
      return [{ k: "text", x: cx - w / 2, y: cy, text, size, fill: col("color") }];
    }
    case "bounce-arrow": {
      const dir = String(v.direction ?? "down");
      const rot = { up: Math.PI, down: 0, left: Math.PI / 2, right: -Math.PI / 2 }[dir] ?? 0;
      const k = (s * 0.8) / 40;
      const p = (x: number, y: number): [number, number] => {
        const dx = (x - 20) * k;
        const dy = (y - 20) * k;
        return [
          cx + dx * Math.cos(rot) - dy * Math.sin(rot),
          cy + dx * Math.sin(rot) + dy * Math.cos(rot),
        ];
      };
      const sw = Math.max(2, 4 * k);
      return [
        { k: "poly", pts: [p(20, 6), p(20, 30)], stroke: col("color"), sw },
        { k: "poly", pts: [p(10, 20), p(20, 30), p(30, 20)], stroke: col("color"), sw },
      ];
    }
    case "gradient-wave":
      return [
        {
          k: "grad",
          x: cx - w / 2,
          y: cy - h / 2,
          w,
          h,
          r: Math.min(8, h / 4),
          stops: [col("from"), col("to"), col("from")],
        },
      ];
  }
};

const FONT = `"Source Sans 3", system-ui, sans-serif`;

const drawPrim = (ctx: CanvasRenderingContext2D, p: StillPrim) => {
  switch (p.k) {
    case "circle":
      ctx.beginPath();
      ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
      if (p.fill) {
        ctx.fillStyle = p.fill;
        ctx.fill();
      }
      if (p.stroke) {
        ctx.strokeStyle = p.stroke;
        ctx.lineWidth = p.sw ?? 2;
        ctx.stroke();
      }
      return;
    case "rect":
    case "grad":
      ctx.beginPath();
      ctx.roundRect(p.x, p.y, p.w, p.h, p.r);
      if (p.k === "rect") ctx.fillStyle = p.fill;
      else {
        const g = ctx.createLinearGradient(p.x, p.y, p.x + p.w, p.y + p.h);
        p.stops.forEach((c, i) => g.addColorStop(i / (p.stops.length - 1), c));
        ctx.fillStyle = g;
      }
      ctx.fill();
      return;
    case "poly":
      ctx.beginPath();
      p.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = p.stroke;
      ctx.lineWidth = p.sw;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      return;
    case "text":
      ctx.font = `${p.size}px ${FONT}`;
      ctx.fillStyle = p.fill;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(p.text, p.x, p.y);
      return;
  }
};

export const drawComponentCard = (
  ctx: CanvasRenderingContext2D,
  el: ComponentElement,
  theme: Theme,
) => {
  const c = COLORS[theme];
  const w = el.width;
  const h = el.height;
  const r = Math.min(10, w / 4, h / 4);
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, r);
  ctx.fillStyle = c.surface;
  ctx.fill();
  ctx.strokeStyle = c.line;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  const still = componentStill(el, theme);
  if (still.length) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, r);
    ctx.clip();
    for (const p of still) drawPrim(ctx, p);
    ctx.restore();
  }
  const { titleY, label } = layout(el);
  if (titleY === null) return;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 14px ${FONT}`;
  ctx.fillStyle = c.ink;
  ctx.fillText(componentCardTitle(el), 0, titleY, Math.max(10, w - 20));
  if (label) {
    ctx.font = `12px ${FONT}`;
    ctx.fillStyle = c.soft;
    ctx.fillText(COMPONENT_CARD_LABEL, 0, titleY + 18, Math.max(10, w - 20));
  }
};

const n = (v: number) => String(Math.round(v * 100) / 100);
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const primSvg = (p: StillPrim, gradId: string): string => {
  switch (p.k) {
    case "circle":
      return `<circle cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}" fill="${p.fill ? esc(p.fill) : "none"}"${p.stroke ? ` stroke="${esc(p.stroke)}" stroke-width="${n(p.sw ?? 2)}"` : ""}/>`;
    case "rect":
      return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" rx="${n(p.r)}" fill="${esc(p.fill)}"/>`;
    case "grad":
      return (
        `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">` +
        p.stops
          .map((c, i) => `<stop offset="${n(i / (p.stops.length - 1))}" stop-color="${esc(c)}"/>`)
          .join("") +
        `</linearGradient></defs>` +
        `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" rx="${n(p.r)}" fill="url(#${gradId})"/>`
      );
    case "poly":
      return `<polyline points="${p.pts.map(([x, y]) => `${n(x)},${n(y)}`).join(" ")}" fill="none" stroke="${esc(p.stroke)}" stroke-width="${n(p.sw)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "text":
      return `<text x="${n(p.x)}" y="${n(p.y)}" font-family="'Source Sans 3', sans-serif" font-size="${n(p.size)}" fill="${esc(p.fill)}" dominant-baseline="central">${esc(p.text)}</text>`;
  }
};

/** The same card as SVG (centred on 0,0 like other SVG bodies). */
export const componentCardSvg = (el: ComponentElement, theme: Theme) => {
  const c = COLORS[theme];
  const w = el.width;
  const h = el.height;
  const r = Math.min(10, w / 4, h / 4);
  let out = `<rect x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" fill="${c.surface}" stroke="${c.line}" stroke-dasharray="6 4"/>`;
  const still = componentStill(el, theme);
  if (still.length) {
    const gid = `cm-wave-${el.id.replace(/[^A-Za-z0-9_-]/g, "")}`;
    out += `<g data-component-still="${esc(el.source.kind === "preset" ? el.source.preset : "")}">${still.map((p) => primSvg(p, gid)).join("")}</g>`;
  }
  const { titleY, label } = layout(el);
  if (titleY === null) return out;
  out += `<text x="0" y="${n(titleY)}" font-family="'Source Sans 3', sans-serif" font-size="14" font-weight="600" fill="${c.ink}" text-anchor="middle" dominant-baseline="central">${esc(componentCardTitle(el))}</text>`;
  if (label)
    out += `<text x="0" y="${n(titleY + 18)}" font-family="'Source Sans 3', sans-serif" font-size="12" fill="${c.soft}" text-anchor="middle" dominant-baseline="central">${COMPONENT_CARD_LABEL}</text>`;
  return out;
};
