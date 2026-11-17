/**
 * The static card for an animated component (MEDIA-05/06): drawn on the board
 * under the live frame, while it is not live (too small, too many, zoomed
 * out), and in PNG/SVG exports, which never run components.
 */
import type { ComponentElement } from "../scene/types";
import { presetByName, presetValues } from "../shared/components";

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

/** The accent colour of a preset's still, or null for custom components. */
export const componentAccent = (el: ComponentElement): string | null => {
  if (el.source.kind !== "preset") return null;
  const def = presetByName(el.source.preset);
  if (!def) return null;
  const v = presetValues(def, el.source.params);
  const c = v.color ?? v.from;
  return typeof c === "string" ? c : "#007f78";
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
  const accent = componentAccent(el);
  const dot = Math.min(16, w / 8, h / 8);
  if (accent && dot > 3) {
    ctx.beginPath();
    ctx.arc(0, -Math.min(24, h / 5), dot, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }
  if (h < 30 || w < 50) return;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 14px "Source Sans 3", system-ui, sans-serif`;
  ctx.fillStyle = c.ink;
  const ty = accent ? Math.min(h / 2 - 28, 8) : -9;
  ctx.fillText(componentCardTitle(el), 0, ty, Math.max(10, w - 20));
  if (h >= 56) {
    ctx.font = `12px "Source Sans 3", system-ui, sans-serif`;
    ctx.fillStyle = c.soft;
    ctx.fillText(COMPONENT_CARD_LABEL, 0, ty + 18, Math.max(10, w - 20));
  }
};

const n = (v: number) => String(Math.round(v * 100) / 100);
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The same card as SVG (centred on 0,0 like other SVG bodies). */
export const componentCardSvg = (el: ComponentElement, theme: Theme) => {
  const c = COLORS[theme];
  const w = el.width;
  const h = el.height;
  const r = Math.min(10, w / 4, h / 4);
  let out = `<rect x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" fill="${c.surface}" stroke="${c.line}" stroke-dasharray="6 4"/>`;
  const accent = componentAccent(el);
  const dot = Math.min(16, w / 8, h / 8);
  if (accent && dot > 3)
    out += `<circle cx="0" cy="${n(-Math.min(24, h / 5))}" r="${n(dot)}" fill="${esc(accent)}"/>`;
  if (h < 30 || w < 50) return out;
  const ty = accent ? Math.min(h / 2 - 28, 8) : -9;
  out += `<text x="0" y="${n(ty)}" font-family="'Source Sans 3', sans-serif" font-size="14" font-weight="600" fill="${c.ink}" text-anchor="middle" dominant-baseline="central">${esc(componentCardTitle(el))}</text>`;
  if (h >= 56)
    out += `<text x="0" y="${n(ty + 18)}" font-family="'Source Sans 3', sans-serif" font-size="12" fill="${c.soft}" text-anchor="middle" dominant-baseline="central">${COMPONENT_CARD_LABEL}</text>`;
  return out;
};
