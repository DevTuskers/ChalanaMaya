import { BOUND_TEXT_PADDING } from "./constants";
import { isBindable, isBoundText, isLinear, newId, newSeed } from "./elements";
import { fromAbsolutePoints, getAbsolutePoints, getCenter, rotatePoint, toLocal } from "./geometry";
import {
  containerTextHeight,
  containerTextWidth,
  fontString,
  lineHeightPx,
  measureLines,
  wrapText,
} from "./text";
import { polylineMidpoint, routedPoints } from "./route";
import type { LinearElement, Point, SceneElement, TextElement } from "./types";

export type Elements = readonly SceneElement[];

export const byId = (elements: Elements) => new Map(elements.map((e) => [e.id, e]));

export const getBoundText = (elements: Elements, containerId: string): TextElement | undefined =>
  elements.find((e): e is TextElement => e.type === "text" && e.containerId === containerId);

/** Positions bound text inside its container, growing the container when text overflows. */
export const syncBoundTexts = (elements: Elements, scope?: Set<string>): SceneElement[] => {
  const map = byId(elements);
  const updates = new Map<string, SceneElement>();
  for (const el of elements) {
    if (!isBoundText(el)) continue;
    if (scope && !scope.has(el.id) && !scope.has(el.containerId!)) continue;
    let container = updates.get(el.containerId!) ?? map.get(el.containerId!);
    if (!container) {
      // its box went away (removed in another tab meanwhile): keep the words as free text
      updates.set(el.id, { ...el, containerId: null });
      continue;
    }
    const font = fontString(el.fontFamily, el.fontSize);
    if (isLinear(container)) {
      // connector label: sits on the middle of the drawn path, never moves endpoints
      const lines = wrapText(el.text, font, null);
      const width = Math.max(4, measureLines(lines, font));
      const height = Math.max(1, lines.length) * lineHeightPx(el.fontSize);
      const mid = polylineMidpoint(routedPoints(container));
      const next: TextElement = {
        ...el,
        x: mid.x - width / 2,
        y: mid.y - height / 2,
        width,
        height,
        angle: 0,
        autoWidth: false,
      };
      if (
        next.x !== el.x ||
        next.y !== el.y ||
        next.width !== el.width ||
        next.height !== el.height ||
        el.angle
      ) {
        updates.set(el.id, next);
      }
      continue;
    }
    const maxW = containerTextWidth(container);
    const lines = wrapText(el.text, font, maxW);
    const height = lines.length * lineHeightPx(el.fontSize);
    const usableH = containerTextHeight(container);
    if (height > usableH) {
      const factor =
        container.type === "ellipse" ? Math.SQRT1_2 : container.type === "diamond" ? 0.5 : 1;
      const needed = (height + BOUND_TEXT_PADDING * 2) / factor;
      container = { ...container, height: needed };
      updates.set(container.id, container);
      scope?.add(container.id);
    }
    const c = getCenter(container);
    const width = maxW;
    const next: TextElement = {
      ...el,
      x: c.x - width / 2,
      y: c.y - height / 2,
      width,
      height,
      angle: container.angle,
      autoWidth: false,
    };
    if (
      next.x !== el.x ||
      next.y !== el.y ||
      next.width !== el.width ||
      next.height !== el.height ||
      next.angle !== el.angle ||
      el.autoWidth
    ) {
      updates.set(el.id, next);
    }
  }
  if (!updates.size) return elements as SceneElement[];
  return elements.map((e) => updates.get(e.id) ?? e);
};

const EPS = 1e-7;
const close = (a: number, b: number) =>
  Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));
/** Keeps the old object when the recomputed connector has the same geometry (Rule A). */
const sameLinear = (a: LinearElement, b: LinearElement) =>
  a.startBinding === b.startBinding &&
  a.endBinding === b.endBinding &&
  close(a.x, b.x) &&
  close(a.y, b.y) &&
  close(a.width, b.width) &&
  close(a.height, b.height) &&
  a.points.length === b.points.length &&
  a.points.every((p, i) => close(p.x, b.points[i].x) && close(p.y, b.points[i].y));

/**
 * Where a ray from the element centre towards `toward` meets the outline,
 * pushed out by `gap`. Works for rotated boxes, diamonds and ellipses.
 */
export const boundaryPoint = (el: SceneElement, toward: Point, gap = 4): Point => {
  const c = getCenter(el);
  const local = toLocal(toward, el);
  const dx = local.x - c.x;
  const dy = local.y - c.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { ...c };
  const hw = Math.max(el.width / 2, 1e-6);
  const hh = Math.max(el.height / 2, 1e-6);
  let t: number;
  if (el.type === "ellipse") t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (el.type === "diamond") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  const edge = { x: c.x + dx * t + (dx / len) * gap, y: c.y + dy * t + (dy / len) * gap };
  return rotatePoint(edge, c, el.angle);
};

/** Middle of the box side facing `toward` (used by elbow connectors). */
export const sidePoint = (el: SceneElement, toward: Point, gap = 4): Point => {
  const c = getCenter(el);
  const local = toLocal(toward, el);
  const dx = (local.x - c.x) / Math.max(el.width, 1);
  const dy = (local.y - c.y) / Math.max(el.height, 1);
  let p: Point;
  if (Math.abs(dx) >= Math.abs(dy)) p = { x: dx >= 0 ? el.x + el.width + gap : el.x - gap, y: c.y };
  else p = { x: c.x, y: dy >= 0 ? el.y + el.height + gap : el.y - gap };
  return rotatePoint(p, c, el.angle);
};

/** Recomputes endpoints of arrows attached to shapes. */
export const updateBindings = (elements: Elements, scope?: Set<string>): SceneElement[] => {
  const map = byId(elements);
  let changed = false;
  const touched: string[] = [];
  const next = elements.map((el) => {
    if (!isLinear(el) || (!el.startBinding && !el.endBinding)) return el;
    if (
      scope &&
      !scope.has(el.id) &&
      !(el.startBinding && scope.has(el.startBinding.elementId)) &&
      !(el.endBinding && scope.has(el.endBinding.elementId))
    )
      return el;
    const result = bindConnector(el, map);
    if (result === el) return el;
    changed = true;
    touched.push(el.id);
    return result;
  });
  for (const id of touched) scope?.add(id);
  return changed ? next : (elements as SceneElement[]);
};

const bindConnector = (el: LinearElement, map: Map<string, SceneElement>): LinearElement => {
  const out = bindConnectorRaw(el, map);
  return out !== el && sameLinear(out, el) ? el : out;
};

const bindConnectorRaw = (el: LinearElement, map: Map<string, SceneElement>): LinearElement => {
  {
    const start = el.startBinding ? map.get(el.startBinding.elementId) : undefined;
    const end = el.endBinding ? map.get(el.endBinding.elementId) : undefined;
    let updated: LinearElement = el;
    if (el.startBinding && !start) updated = { ...updated, startBinding: null };
    if (el.endBinding && !end) updated = { ...updated, endBinding: null };
    if (!start && !end) return updated;
    const abs = getAbsolutePoints(el);
    const n = abs.length;
    if (n < 2) return updated;
    if (el.type === "arrow" && el.routing === "elbow") {
      if (start) abs[0] = sidePoint(start, end ? getCenter(end) : abs[1]);
      if (end) abs[n - 1] = sidePoint(end, start ? getCenter(start) : abs[n - 2]);
      return fromAbsolutePoints(updated, abs);
    }
    if (start) {
      const target = n === 2 && end ? getCenter(end) : abs[1];
      abs[0] = boundaryPoint(start, target);
    }
    if (end) {
      const target = n === 2 && start ? getCenter(start) : abs[n - 2];
      abs[n - 1] = boundaryPoint(end, target);
    }
    return fromAbsolutePoints(updated, abs);
  }
};

/** Topmost element that an arrow endpoint at `p` would attach to. */
export const bindingTargetAt = (
  elements: Elements,
  p: Point,
  excludeIds: ReadonlySet<string> = new Set(),
  margin = 6,
): SceneElement | null => {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (excludeIds.has(el.id) || !isBindable(el) || el.locked) continue;
    const local = toLocal(p, el);
    if (
      local.x >= el.x - margin &&
      local.x <= el.x + el.width + margin &&
      local.y >= el.y - margin &&
      local.y <= el.y + el.height + margin
    ) {
      return el;
    }
  }
  return null;
};

/** Ids plus the text bound inside any of them. */
export const withBoundTexts = (elements: Elements, ids: Iterable<string>): Set<string> => {
  const set = new Set(ids);
  for (const el of elements) {
    if (el.type === "text" && el.containerId && set.has(el.containerId)) set.add(el.id);
  }
  return set;
};

/** Removes editable (unlocked) elements, their bound text and dangling bindings. */
export const deleteElements = (elements: Elements, ids: Iterable<string>): SceneElement[] => {
  const map = byId(elements);
  const editable = [...ids].filter((id) => map.get(id) && !map.get(id)!.locked);
  const remove = withBoundTexts(elements, editable);
  const remaining = elements.filter((e) => !remove.has(e.id));
  return remaining.map((e) => {
    if (e.frameId && remove.has(e.frameId)) e = { ...e, frameId: null };
    if (!isLinear(e)) return e;
    const s = e.startBinding && remove.has(e.startBinding.elementId);
    const en = e.endBinding && remove.has(e.endBinding.elementId);
    if (!s && !en) return e;
    return { ...e, startBinding: s ? null : e.startBinding, endBinding: en ? null : e.endBinding };
  });
};

/**
 * Deep-copies elements with fresh ids. Relationships inside the copied set are
 * kept (arrow bindings, bound text); links to elements outside it are dropped.
 */
export const cloneElements = (
  source: Elements,
  dx = 0,
  dy = 0,
): { clones: SceneElement[]; idMap: Map<string, string> } => {
  const idMap = new Map<string, string>();
  for (const el of source) idMap.set(el.id, newId());
  const groupMap = new Map<string, string>();
  const mapGroup = (g: string) => {
    if (!groupMap.has(g)) groupMap.set(g, newId());
    return groupMap.get(g)!;
  };
  const clones = source
    .filter((el) => !(el.type === "text" && el.containerId && !idMap.has(el.containerId)))
    .map((el): SceneElement => {
      const copy = structuredClone(el) as SceneElement;
      copy.id = idMap.get(el.id)!;
      copy.x += dx;
      copy.y += dy;
      copy.seed = newSeed();
      copy.locked = false;
      copy.groupIds = el.groupIds.map(mapGroup);
      if (copy.frameId) copy.frameId = idMap.get(copy.frameId) ?? copy.frameId;
      if (copy.type === "text" && copy.containerId) copy.containerId = idMap.get(copy.containerId)!;
      if (isLinear(copy)) {
        copy.startBinding =
          copy.startBinding && idMap.has(copy.startBinding.elementId)
            ? { elementId: idMap.get(copy.startBinding.elementId)! }
            : null;
        copy.endBinding =
          copy.endBinding && idMap.has(copy.endBinding.elementId)
            ? { elementId: idMap.get(copy.endBinding.elementId)! }
            : null;
      }
      return copy;
    });
  return { clones, idMap };
};

/** Duplicates the selection (plus bound text) next to the original. */
export const duplicateElements = (
  elements: Elements,
  ids: Iterable<string>,
  offset = 16,
): { elements: SceneElement[]; newIds: string[] } => {
  const set = withBoundTexts(elements, ids);
  const source = elements.filter((e) => set.has(e.id));
  const { clones, idMap } = cloneElements(source, offset, offset);
  const newIds = [...ids].map((id) => idMap.get(id)).filter((x): x is string => !!x);
  return { elements: [...elements, ...clones], newIds };
};

/** Elements the user can pick: unlocked and not text living inside a shape. */
export const isSelectable = (el: SceneElement) => !el.locked && !isBoundText(el);

export const selectAll = (elements: Elements): string[] =>
  elements.filter(isSelectable).map((e) => e.id);

/**
 * Applies bindings and bound text layout after any geometry change (Rule A).
 * Idempotent: unchanged elements keep their object, and a no-op pass returns the
 * same array. With `touched`, only those ids, their labels and their connectors
 * (and those connectors' labels) are recomputed.
 */
export const finalizeScene = (elements: Elements, touched?: Iterable<string>): SceneElement[] => {
  const scope = touched ? new Set(touched) : undefined;
  // labels/containers first, then connectors, then connector labels on moved paths
  return syncBoundTexts(updateBindings(syncBoundTexts(elements, scope), scope), scope);
};
