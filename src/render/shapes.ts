import rough from "roughjs";
import type { Drawable, Options } from "roughjs/bin/core";
import { getStroke } from "perfect-freehand";
import { INK, INK_DARK, TRANSPARENT } from "../scene/constants";
import { elbowRoute, curveRoute } from "../scene/route";
import type {
  Arrowhead,
  FreedrawElement,
  LinearElement,
  Point,
  SceneElement,
  Theme,
} from "../scene/types";

export const generator = rough.generator();

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
  "#52706b": "#8fb3ad",
};

export const resolveColor = (color: string, theme: Theme) =>
  theme === "dark" ? (DARK_INKS[color.toLowerCase()] ?? color) : color;

const ROUGHNESS = [
  { roughness: 0, bowing: 0 },
  { roughness: 1, bowing: 1 },
  { roughness: 2.4, bowing: 2 },
];

export const dashFor = (el: SceneElement): number[] | undefined => {
  if (el.strokeStyle === "dashed") return [8 + el.strokeWidth * 2, 6 + el.strokeWidth * 1.5];
  if (el.strokeStyle === "dotted") return [1.5, 4 + el.strokeWidth * 2];
  return undefined;
};

export const roughOptions = (el: SceneElement, theme: Theme, fill: boolean): Options => {
  const r = ROUGHNESS[el.roughness] ?? ROUGHNESS[1];
  const dash = dashFor(el);
  return {
    seed: el.seed,
    stroke: resolveColor(el.strokeColor, theme),
    strokeWidth: el.strokeWidth,
    roughness: r.roughness,
    bowing: r.bowing,
    fill: fill && el.backgroundColor !== TRANSPARENT ? el.backgroundColor : undefined,
    fillStyle: el.fillStyle,
    fillWeight: Math.max(0.5, el.strokeWidth / 2),
    hachureGap: 4 + el.strokeWidth * 1.5,
    preserveVertices: true,
    strokeLineDash: dash,
    disableMultiStroke: !!dash,
  };
};

/** SVG path for a rounded rectangle centred on the origin. */
const roundRectPath = (w: number, h: number, r: number) => {
  const x = -w / 2;
  const y = -h / 2;
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M${x + r} ${y} L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} L${x + w} ${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} L${x + r} ${y + h} Q${x} ${y + h} ${x} ${y + h - r} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} Z`;
};

/** Path through points with rounded bends (for round elbow connectors and diamonds). */
const roundedPolyPath = (pts: Point[], r: number, closed: boolean) => {
  if (pts.length < 3 && !closed) return `M${pts.map((p) => `${p.x} ${p.y}`).join(" L")}`;
  const n = pts.length;
  const corner = (i: number) => {
    const p = pts[i];
    const a = pts[(i - 1 + n) % n];
    const b = pts[(i + 1) % n];
    const la = Math.hypot(a.x - p.x, a.y - p.y) || 1;
    const lb = Math.hypot(b.x - p.x, b.y - p.y) || 1;
    const ra = Math.min(r, la / 2);
    const rb = Math.min(r, lb / 2);
    return {
      in: { x: p.x + ((a.x - p.x) / la) * ra, y: p.y + ((a.y - p.y) / la) * ra },
      out: { x: p.x + ((b.x - p.x) / lb) * rb, y: p.y + ((b.y - p.y) / lb) * rb },
      p,
    };
  };
  if (closed) {
    const cs = pts.map((_, i) => corner(i));
    let d = `M${cs[0].out.x} ${cs[0].out.y}`;
    for (let i = 1; i <= n; i++) {
      const c = cs[i % n];
      d += ` L${c.in.x} ${c.in.y} Q${c.p.x} ${c.p.y} ${c.out.x} ${c.out.y}`;
    }
    return d + " Z";
  }
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < n - 1; i++) {
    const c = corner(i);
    d += ` L${c.in.x} ${c.in.y} Q${c.p.x} ${c.p.y} ${c.out.x} ${c.out.y}`;
  }
  return d + ` L${pts[n - 1].x} ${pts[n - 1].y}`;
};

/** Drawn polyline for a linear element, relative to its centre. */
export const localRoute = (el: LinearElement): Point[] => {
  const ox = -el.width / 2;
  const oy = -el.height / 2;
  const pts = el.points.map((p) => ({ x: p.x + ox, y: p.y + oy }));
  if (el.type !== "arrow" || el.routing === "straight") return pts;
  return el.routing === "elbow" ? elbowRoute(pts) : curveRoute(pts);
};

const endDirection = (pts: Point[], atStart: boolean) => {
  const seq = atStart ? [...pts].reverse() : pts;
  const end = seq[seq.length - 1];
  let prev = seq[seq.length - 2];
  for (let i = seq.length - 2; i >= 0 && Math.hypot(end.x - prev.x, end.y - prev.y) < 1; i--)
    prev = seq[i];
  const len = Math.hypot(end.x - prev.x, end.y - prev.y);
  if (len < 1) return null;
  return { end, angle: Math.atan2(end.y - prev.y, end.x - prev.x), len };
};

/** Drawables for one arrowhead marker placed at a path end. */
const markerDrawables = (
  el: LinearElement,
  pts: Point[],
  kind: Arrowhead,
  atStart: boolean,
  theme: Theme,
): Drawable[] => {
  if (kind === "none" || pts.length < 2) return [];
  const dir = endDirection(pts, atStart);
  if (!dir) return [];
  const { end, angle } = dir;
  const s = Math.min(12 + el.strokeWidth * 3, dir.len * 0.6);
  const at = (back: number, side: number) => ({
    x: end.x - back * Math.cos(angle) - side * Math.sin(angle),
    y: end.y - back * Math.sin(angle) + side * Math.cos(angle),
  });
  const ink = resolveColor(el.strokeColor, theme);
  const base = {
    ...roughOptions(el, theme, false),
    strokeLineDash: undefined,
    disableMultiStroke: false,
  };
  const solid = { ...base, fill: ink, fillStyle: "solid" as const };
  const tup = (p: Point) => [p.x, p.y] as [number, number];
  const spread = Math.tan(Math.PI / 7) * s;
  const out: Drawable[] = [];
  const bar = (back: number) =>
    out.push(generator.linearPath([tup(at(back, -s / 2)), tup(at(back, s / 2))], base));
  const crow = () =>
    out.push(
      generator.linearPath([tup(at(s, 0)), tup(at(0, -s / 2))], base),
      generator.linearPath([tup(at(s, 0)), tup(at(0, s / 2))], base),
    );
  const ring = (back: number) => {
    const c = at(back, 0);
    out.push(generator.circle(c.x, c.y, s * 0.55, { ...base, fill: undefined }));
  };
  switch (kind) {
    case "arrow":
      out.push(generator.linearPath([tup(at(s, -spread)), tup(end), tup(at(s, spread))], base));
      break;
    case "triangle":
    case "triangle-outline":
      out.push(
        generator.polygon(
          [tup(end), tup(at(s, -spread)), tup(at(s, spread))],
          kind === "triangle" ? solid : base,
        ),
      );
      break;
    case "circle":
    case "circle-outline": {
      const c = at(s * 0.35, 0);
      out.push(generator.circle(c.x, c.y, s * 0.7, kind === "circle" ? solid : base));
      break;
    }
    case "diamond":
    case "diamond-outline":
      out.push(
        generator.polygon(
          [tup(end), tup(at(s * 0.6, -s * 0.35)), tup(at(s * 1.2, 0)), tup(at(s * 0.6, s * 0.35))],
          kind === "diamond" ? solid : base,
        ),
      );
      break;
    case "bar":
      bar(0);
      break;
    case "er-one":
      bar(s * 0.5);
      bar(s * 0.8);
      break;
    case "er-many":
      crow();
      break;
    case "er-zero":
      ring(s * 0.6);
      break;
    case "er-zero-one":
      bar(s * 0.4);
      ring(s * 1.0);
      break;
    case "er-zero-many":
      crow();
      ring(s * 1.4);
      break;
    case "er-one-many":
      crow();
      bar(s * 1.2);
      break;
  }
  return out;
};

/** Roughjs drawables for an element, in coordinates relative to its centre. */
export const buildDrawables = (el: SceneElement, theme: Theme): Drawable[] => {
  const w = el.width;
  const h = el.height;
  const ox = -w / 2;
  const oy = -h / 2;
  const round = el.edges === "round";
  const radius = Math.min(Math.abs(w), Math.abs(h)) * 0.18;
  switch (el.type) {
    case "rectangle":
      return round
        ? [generator.path(roundRectPath(w, h, radius), roughOptions(el, theme, true))]
        : [generator.rectangle(ox, oy, w, h, roughOptions(el, theme, true))];
    case "note":
      return [generator.path(roundRectPath(w, h, 10), roughOptions(el, theme, true))];
    case "frame":
      return [
        generator.path(roundRectPath(w, h, 8), {
          ...roughOptions(el, theme, false),
          roughness: 0,
          bowing: 0,
        }),
      ];
    case "diamond": {
      const pts = [
        { x: 0, y: oy },
        { x: -ox, y: 0 },
        { x: 0, y: -oy },
        { x: ox, y: 0 },
      ];
      return round
        ? [generator.path(roundedPolyPath(pts, radius, true), roughOptions(el, theme, true))]
        : [
            generator.polygon(
              pts.map((p) => [p.x, p.y] as [number, number]),
              roughOptions(el, theme, true),
            ),
          ];
    }
    case "ellipse":
      return [generator.ellipse(0, 0, w, h, roughOptions(el, theme, true))];
    case "line":
    case "arrow": {
      const pts = localRoute(el);
      if (pts.length < 2) return [];
      const tuples = pts.map((p) => [p.x, p.y] as [number, number]);
      if (el.type === "line" && el.closed) {
        return [generator.polygon(tuples, roughOptions(el, theme, true))];
      }
      const out: Drawable[] =
        el.type === "arrow" && el.routing === "elbow" && round
          ? [generator.path(roundedPolyPath(pts, 16, false), roughOptions(el, theme, false))]
          : el.type === "arrow" && el.routing === "curved"
            ? [generator.curve(tuples, roughOptions(el, theme, false))]
            : [generator.linearPath(tuples, roughOptions(el, theme, false))];
      out.push(...markerDrawables(el, pts, el.endArrowhead, false, theme));
      out.push(...markerDrawables(el, pts, el.startArrowhead, true, theme));
      return out;
    }
    default:
      return [];
  }
};

/** Outline polygon of a pencil stroke, relative to its centre. */
/** True when the stroke carries real stylus pressure (DRAW-09). */
export const hasPressure = (el: FreedrawElement) =>
  !!el.pressures && el.pressures.length === el.points.length && el.points.length > 0;

/** Input points for perfect-freehand, with pressure as the third value when recorded. */
export const freedrawInput = (el: FreedrawElement, ox = 0, oy = 0): number[][] => {
  const pr = hasPressure(el) ? el.pressures! : null;
  return el.points.map((p, i) => (pr ? [p.x + ox, p.y + oy, pr[i]] : [p.x + ox, p.y + oy]));
};

/**
 * Strokes with recorded pressure vary in width with the pen; all others keep a
 * steady width so mouse and touch drawings look even.
 */
export const freedrawOptions = (el: FreedrawElement) => {
  const pressure = hasPressure(el);
  return {
    size: el.strokeWidth * 3 + 2,
    thinning: pressure ? 0.6 : 0,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: false,
    last: true,
  };
};

export const freedrawOutline = (el: FreedrawElement): number[][] => {
  const ox = -el.width / 2;
  const oy = -el.height / 2;
  return getStroke(freedrawInput(el, ox, oy), freedrawOptions(el));
};

export const outlineToSvgPath = (outline: number[][]) => {
  if (!outline.length) return "";
  let d = `M${outline[0][0].toFixed(2)} ${outline[0][1].toFixed(2)}`;
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1];
    const [x1, y1] = outline[i];
    d += ` Q${x0.toFixed(2)} ${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(2)} ${((y0 + y1) / 2).toFixed(2)}`;
  }
  return d + " Z";
};
