import { hasOutline, isBoundText, isFillable, isLinear, isShape, newId } from "./elements";
import {
  boundsContain,
  getAbsolutePoints,
  getCenter,
  getCommonBounds,
  getElementBounds,
  fromAbsolutePoints,
  pointInPolygon,
} from "./geometry";
import { hitElement } from "./hit";
import { type Elements } from "./scene";
import type {
  Bounds,
  ItemStyle,
  LinearElement,
  Point,
  SceneElement,
  ShapeType,
} from "./types";

const outerGroup = (el: SceneElement) => el.groupIds[el.groupIds.length - 1] ?? null;

/** Expands ids so that picking one member of a group picks the whole outer group. */
export const expandGroups = (elements: Elements, ids: Iterable<string>): Set<string> => {
  const set = new Set(ids);
  const groups = new Set<string>();
  for (const el of elements) if (set.has(el.id) && outerGroup(el)) groups.add(outerGroup(el)!);
  if (!groups.size) return set;
  for (const el of elements) {
    const g = outerGroup(el);
    if (g && groups.has(g) && !el.locked) set.add(el.id);
  }
  return set;
};

/** Ids plus everything that should travel with them (frame contents, bound text). */
export const withDependents = (elements: Elements, ids: Iterable<string>): Set<string> => {
  const set = new Set(ids);
  const frames = new Set(elements.filter((e) => e.type === "frame" && set.has(e.id)).map((e) => e.id));
  for (const el of elements) {
    if (el.frameId && frames.has(el.frameId) && !el.locked) set.add(el.id);
  }
  for (const el of elements) {
    if (el.type === "text" && el.containerId && set.has(el.containerId)) set.add(el.id);
  }
  return set;
};

export const groupElements = (elements: Elements, ids: ReadonlySet<string>) => {
  const picked = elements.filter((e) => ids.has(e.id) && !e.locked && !isBoundText(e));
  if (picked.length < 2) return null;
  const gid = newId();
  return elements.map((e) =>
    ids.has(e.id) && !e.locked && !isBoundText(e) ? { ...e, groupIds: [...e.groupIds, gid] } : e,
  );
};

export const ungroupElements = (elements: Elements, ids: ReadonlySet<string>) => {
  let changed = false;
  const next = elements.map((e) => {
    if (!ids.has(e.id) || !e.groupIds.length || e.locked) return e;
    changed = true;
    return { ...e, groupIds: e.groupIds.slice(0, -1) };
  });
  return changed ? next : null;
};

/** Keeps every bound text directly above its container. */
const keepTextsWithContainers = (elements: SceneElement[]): SceneElement[] => {
  const texts = new Map<string, SceneElement[]>();
  const rest: SceneElement[] = [];
  for (const el of elements) {
    if (isBoundText(el)) {
      const list = texts.get(el.containerId!) ?? [];
      list.push(el);
      texts.set(el.containerId!, list);
    } else rest.push(el);
  }
  const out: SceneElement[] = [];
  for (const el of rest) {
    out.push(el);
    const t = texts.get(el.id);
    if (t) out.push(...t);
  }
  return out;
};

export type ZOrder = "front" | "back" | "forward" | "backward";

export const reorder = (elements: Elements, ids: ReadonlySet<string>, op: ZOrder) => {
  const moving = (e: SceneElement) => ids.has(e.id) && !e.locked;
  const base = elements.filter((e) => !isBoundText(e));
  if (!base.some(moving)) return null;
  let arr = [...base];
  if (op === "front") arr = [...arr.filter((e) => !moving(e)), ...arr.filter(moving)];
  else if (op === "back") arr = [...arr.filter(moving), ...arr.filter((e) => !moving(e))];
  else if (op === "forward") {
    for (let i = arr.length - 2; i >= 0; i--) {
      if (moving(arr[i]) && !moving(arr[i + 1])) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    }
  } else {
    for (let i = 1; i < arr.length; i++) {
      if (moving(arr[i]) && !moving(arr[i - 1])) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
    }
  }
  return keepTextsWithContainers([...arr, ...elements.filter(isBoundText)]);
};

/** Selected items as arrangement units: each outer group moves as one. */
const units = (elements: Elements, ids: ReadonlySet<string>) => {
  const map = new Map<string, SceneElement[]>();
  for (const el of elements) {
    if (!ids.has(el.id) || el.locked || isBoundText(el)) continue;
    const key = outerGroup(el) ?? el.id;
    const list = map.get(key) ?? [];
    list.push(el);
    map.set(key, list);
  }
  return [...map.values()].map((els) => ({ els, b: getCommonBounds(els)! }));
};

const shift = (elements: Elements, offsets: Map<string, Point>) =>
  elements.map((e) => {
    const key = e.type === "text" && e.containerId ? e.containerId : e.id;
    const o = offsets.get(key);
    if (!o || (!o.x && !o.y)) return e;
    return { ...e, x: e.x + o.x, y: e.y + o.y };
  });

export type Align = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

export const alignElements = (elements: Elements, ids: ReadonlySet<string>, mode: Align) => {
  const us = units(elements, ids);
  if (us.length < 2) return null;
  const all = getCommonBounds(us.flatMap((u) => u.els))!;
  const offsets = new Map<string, Point>();
  for (const u of us) {
    let dx = 0;
    let dy = 0;
    if (mode === "left") dx = all.minX - u.b.minX;
    if (mode === "right") dx = all.maxX - u.b.maxX;
    if (mode === "hcenter") dx = (all.minX + all.maxX) / 2 - (u.b.minX + u.b.maxX) / 2;
    if (mode === "top") dy = all.minY - u.b.minY;
    if (mode === "bottom") dy = all.maxY - u.b.maxY;
    if (mode === "vcenter") dy = (all.minY + all.maxY) / 2 - (u.b.minY + u.b.maxY) / 2;
    for (const el of u.els) offsets.set(el.id, { x: dx, y: dy });
  }
  return shift(elements, offsets);
};

/** Equal gaps between items, keeping the outermost two in place. */
export const distributeElements = (
  elements: Elements,
  ids: ReadonlySet<string>,
  axis: "horizontal" | "vertical",
) => {
  const us = units(elements, ids);
  if (us.length < 3) return null;
  const h = axis === "horizontal";
  us.sort((a, b) => (h ? a.b.minX - b.b.minX : a.b.minY - b.b.minY));
  const size = (b: Bounds) => (h ? b.maxX - b.minX : b.maxY - b.minY);
  const first = us[0].b;
  const last = us[us.length - 1].b;
  const span = h ? last.maxX - first.minX : last.maxY - first.minY;
  const gap = (span - us.reduce((s, u) => s + size(u.b), 0)) / (us.length - 1);
  let cursor = h ? first.minX : first.minY;
  const offsets = new Map<string, Point>();
  for (const u of us) {
    const d = cursor - (h ? u.b.minX : u.b.minY);
    for (const el of u.els) offsets.set(el.id, h ? { x: d, y: 0 } : { x: 0, y: d });
    cursor += size(u.b) + gap;
  }
  return shift(elements, offsets);
};

/** Mirrors items across the centre of the selection. */
export const flipElements = (
  elements: Elements,
  ids: ReadonlySet<string>,
  axis: "horizontal" | "vertical",
) => {
  const targets = elements.filter((e) => ids.has(e.id) && !e.locked && !isBoundText(e));
  if (!targets.length) return null;
  const b = getCommonBounds(targets)!;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const h = axis === "horizontal";
  const set = new Set(targets.map((t) => t.id));
  const flipped = new Map<string, SceneElement>();
  for (const el of targets) {
    let next: SceneElement;
    if (isLinear(el) || el.type === "freedraw") {
      const abs = getAbsolutePoints(el).map((p) => (h ? { x: 2 * cx - p.x, y: p.y } : { x: p.x, y: 2 * cy - p.y }));
      next = fromAbsolutePoints(el, abs);
    } else {
      const c = getCenter(el);
      const nc = h ? { x: 2 * cx - c.x, y: c.y } : { x: c.x, y: 2 * cy - c.y };
      next = { ...el, x: nc.x - el.width / 2, y: nc.y - el.height / 2 };
      if (next.type === "image") next = h ? { ...next, flipX: !next.flipX } : { ...next, flipY: !next.flipY };
    }
    next = { ...next, angle: el.angle ? -el.angle : 0 };
    if (isLinear(next) && isLinear(el)) {
      // bindings stay correct because both ends are mirrored with their targets only when selected
      next = {
        ...next,
        startBinding: el.startBinding && set.has(el.startBinding.elementId) ? el.startBinding : null,
        endBinding: el.endBinding && set.has(el.endBinding.elementId) ? el.endBinding : null,
      } as LinearElement;
    }
    flipped.set(el.id, next);
  }
  return elements.map((e) => flipped.get(e.id) ?? e);
};

export const setLocked = (elements: Elements, ids: ReadonlySet<string> | "all", locked: boolean) => {
  let changed = false;
  const next = elements.map((e) => {
    if (ids !== "all" && !ids.has(e.id)) return e;
    if (isBoundText(e) || e.locked === locked) return e;
    changed = true;
    return { ...e, locked };
  });
  return changed ? next : null;
};

/** Switches boxes/diamonds/ovals among each other, or connectors and paths. */
export const switchType = (
  elements: Elements,
  ids: ReadonlySet<string>,
  type: ShapeType | "arrow" | "line",
) => {
  let changed = false;
  const next = elements.map((e): SceneElement => {
    if (!ids.has(e.id) || e.locked || e.type === type) return e;
    if (isShape(e) && (type === "rectangle" || type === "diamond" || type === "ellipse")) {
      changed = true;
      return { ...e, type, edges: type === "ellipse" ? "sharp" : e.edges };
    }
    if (isLinear(e) && (type === "arrow" || type === "line") && !e.closed) {
      changed = true;
      return type === "line"
        ? { ...e, type, startBinding: null, endBinding: null, startArrowhead: "none", endArrowhead: "none", routing: "straight" }
        : { ...e, type, endArrowhead: "arrow" };
    }
    return e;
  });
  if (!changed) return null;
  if (type === "line") {
    // labels belong to connectors only; free them as standalone words
    const lines = new Set(next.filter((e) => e.type === "line").map((e) => e.id));
    return next.map((e) =>
      e.type === "text" && e.containerId && lines.has(e.containerId)
        ? { ...e, containerId: null, autoWidth: true }
        : e,
    );
  }
  return next;
};

const SAFE_SCHEMES = ["http:", "https:", "mailto:"];

/**
 * Normalises a link typed by the user. Returns null for unsafe or invalid input.
 * Internal links look like "#el=<id>".
 */
export const normalizeLink = (input: string): string | null => {
  const v = input.trim();
  if (!v) return null;
  if (v.startsWith("#el=")) return v.length > 4 ? v : null;
  let candidate = v;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) candidate = `https://${v}`;
  try {
    const url = new URL(candidate);
    if (!SAFE_SCHEMES.includes(url.protocol)) return null;
    if (url.protocol !== "mailto:" && !url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
};

export const internalTarget = (link: string) => (link.startsWith("#el=") ? link.slice(4) : null);

/** Unlocked elements touched by an eraser trail. */
export const elementsUnderTrail = (elements: Elements, trail: Point[], tolerance: number) => {
  const hit = new Set<string>();
  for (const el of elements) {
    if (el.locked || isBoundText(el)) continue;
    for (const p of trail) {
      if (hitElement(el, p, tolerance)) {
        hit.add(el.id);
        break;
      }
    }
  }
  return hit;
};

const outlinePoints = (el: SceneElement): Point[] => {
  if (isLinear(el) || el.type === "freedraw") return getAbsolutePoints(el);
  const b = getElementBounds(el);
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
};

/** Unlocked elements fully enclosed by a closed loop. */
export const elementsInLasso = (elements: Elements, loop: Point[]) => {
  if (loop.length < 3) return [];
  return elements
    .filter((el) => !el.locked && !isBoundText(el))
    .filter((el) => outlinePoints(el).every((p) => pointInPolygon(p, loop)))
    .map((e) => e.id);
};

/** Assigns elements to the frame that fully contains them (or removes them from it). */
export const assignFrames = (elements: Elements, ids?: ReadonlySet<string>) => {
  const frames = elements.filter((e) => e.type === "frame");
  let changed = false;
  const next = elements.map((el) => {
    if (el.type === "frame" || isBoundText(el)) return el;
    if (ids && !ids.has(el.id)) return el;
    const b = getElementBounds(el);
    let owner: string | null = null;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (boundsContain(getElementBounds(frames[i]), b)) {
        owner = frames[i].id;
        break;
      }
    }
    if (owner === el.frameId) return el;
    changed = true;
    return { ...el, frameId: owner };
  });
  return changed ? next : (elements as SceneElement[]);
};

export interface SnapResult {
  dx: number;
  dy: number;
  lines: { x1: number; y1: number; x2: number; y2: number }[];
}

const keyXs = (b: Bounds) => [b.minX, (b.minX + b.maxX) / 2, b.maxX];
const keyYs = (b: Bounds) => [b.minY, (b.minY + b.maxY) / 2, b.maxY];

/** Snaps a moving box to nearby edges, centres and midpoints of other items. */
export const snapBox = (
  elements: Elements,
  moving: Bounds,
  exclude: ReadonlySet<string>,
  threshold: number,
): SnapResult => {
  const others = elements.filter((e) => !exclude.has(e.id) && !isBoundText(e));
  let best = { dx: Infinity, dy: Infinity, x: 0, y: 0, bx: null as Bounds | null, by: null as Bounds | null };
  for (const o of others) {
    const ob = getElementBounds(o);
    for (const tx of keyXs(ob))
      for (const mx of keyXs(moving)) {
        const d = tx - mx;
        if (Math.abs(d) <= threshold && Math.abs(d) < Math.abs(best.dx)) best = { ...best, dx: d, x: tx, bx: ob };
      }
    for (const ty of keyYs(ob))
      for (const my of keyYs(moving)) {
        const d = ty - my;
        if (Math.abs(d) <= threshold && Math.abs(d) < Math.abs(best.dy)) best = { ...best, dy: d, y: ty, by: ob };
      }
  }
  const dx = isFinite(best.dx) ? best.dx : 0;
  const dy = isFinite(best.dy) ? best.dy : 0;
  const lines: SnapResult["lines"] = [];
  if (best.bx) {
    lines.push({
      x1: best.x,
      x2: best.x,
      y1: Math.min(best.bx.minY, moving.minY + dy),
      y2: Math.max(best.bx.maxY, moving.maxY + dy),
    });
  }
  if (best.by) {
    lines.push({
      y1: best.y,
      y2: best.y,
      x1: Math.min(best.by.minX, moving.minX + dx),
      x2: Math.max(best.by.maxX, moving.maxX + dx),
    });
  }
  return { dx, dy, lines };
};

/** Snaps a single point (e.g. a drawing corner). */
export const snapPoint = (elements: Elements, p: Point, exclude: ReadonlySet<string>, threshold: number) => {
  const r = snapBox(elements, { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y }, exclude, threshold);
  return { point: { x: p.x + r.dx, y: p.y + r.dy }, lines: r.lines };
};

/** Inserts a point in the middle of segment `index` → `index + 1`. */
export const insertPoint = (el: LinearElement, index: number): LinearElement => {
  const abs = getAbsolutePoints(el);
  if (index < 0 || index >= abs.length - 1) return el;
  const a = abs[index];
  const b = abs[index + 1];
  abs.splice(index + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return fromAbsolutePoints(el, abs);
};

/** Removes a point; refuses (returns null) when the path would be unusable. */
export const removePoint = (el: LinearElement, index: number): LinearElement | null => {
  const min = el.closed ? 3 : 2;
  if (el.points.length <= min || index < 0 || index >= el.points.length) return null;
  const abs = getAbsolutePoints(el);
  abs.splice(index, 1);
  let next = fromAbsolutePoints(el, abs);
  if (index === 0) next = { ...next, startBinding: null };
  if (index === el.points.length - 1) next = { ...next, endBinding: null };
  return next;
};

export const movePoint = (el: LinearElement, index: number, p: Point): LinearElement => {
  const abs = getAbsolutePoints(el);
  if (index < 0 || index >= abs.length) return el;
  abs[index] = { ...p };
  return fromAbsolutePoints(el, abs);
};

const STYLE_KEYS = [
  "strokeColor",
  "backgroundColor",
  "strokeWidth",
  "fillStyle",
  "strokeStyle",
  "roughness",
  "edges",
  "opacity",
  "fontFamily",
  "fontSize",
  "textAlign",
  "routing",
  "startArrowhead",
  "endArrowhead",
] as const;

/** Visual settings of an element (never content or geometry). */
export const extractStyle = (el: SceneElement): Partial<ItemStyle> => {
  const out: Record<string, unknown> = {};
  const src = el as unknown as Record<string, unknown>;
  for (const k of STYLE_KEYS) if (k in src) out[k] = src[k];
  return out as Partial<ItemStyle>;
};

/** Whether a style key is meaningful for an element. */
export const acceptsStyle = (el: SceneElement, k: keyof ItemStyle): boolean => {
  switch (k) {
    case "strokeColor":
      return el.type !== "image" && el.type !== "frame";
    case "backgroundColor":
      return isFillable(el);
    case "fillStyle":
      return isFillable(el) && el.type !== "note";
    case "strokeWidth":
    case "strokeStyle":
      return hasOutline(el) || (k === "strokeWidth" && el.type === "freedraw");
    case "roughness":
      return hasOutline(el);
    case "edges":
      return el.type === "rectangle" || el.type === "diamond" || el.type === "note" || el.type === "arrow";
    case "opacity":
      return true;
    case "fontFamily":
    case "fontSize":
      return el.type === "text";
    case "textAlign":
      return el.type === "text" && !el.containerId;
    case "routing":
    case "startArrowhead":
    case "endArrowhead":
      return el.type === "arrow";
  }
};

/** Applies style keys that each target supports; geometry and content stay. */
export const pasteStyle = (elements: Elements, ids: ReadonlySet<string>, style: Partial<ItemStyle>) => {
  const targets = new Set(ids);
  for (const el of elements) if (isBoundText(el) && targets.has(el.containerId!)) targets.add(el.id);
  let changed = false;
  const next = elements.map((el) => {
    if (!targets.has(el.id) || el.locked) return el;
    const src = el as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of STYLE_KEYS) {
      if (style[k] === undefined || !acceptsStyle(el, k) || src[k] === style[k]) continue;
      patch[k] = style[k];
    }
    if (!Object.keys(patch).length) return el;
    changed = true;
    return { ...el, ...patch } as SceneElement;
  });
  return changed ? next : null;
};
