import { BOUND_TEXT_PADDING } from "./constants";
import { isBindable, isBoundText, isLinear, newId, newSeed } from "./elements";
import { fromAbsolutePoints, getAbsolutePoints, getCenter, rotatePoint, toLocal } from "./geometry";
import {
  containerTextHeight,
  containerTextWidth,
  fontString,
  lineHeightPx,
  wrapText,
} from "./text";
import type { LinearElement, Point, SceneElement, TextElement } from "./types";

export type Elements = readonly SceneElement[];

export const byId = (elements: Elements) => new Map(elements.map((e) => [e.id, e]));

export const getBoundText = (elements: Elements, containerId: string): TextElement | undefined =>
  elements.find((e): e is TextElement => e.type === "text" && e.containerId === containerId);

/** Positions bound text inside its container, growing the container when text overflows. */
export const syncBoundTexts = (elements: Elements): SceneElement[] => {
  const map = byId(elements);
  const updates = new Map<string, SceneElement>();
  for (const el of elements) {
    if (!isBoundText(el)) continue;
    let container = updates.get(el.containerId!) ?? map.get(el.containerId!);
    if (!container) continue;
    const font = fontString(el.fontFamily, el.fontSize);
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

/** Recomputes endpoints of arrows attached to shapes. */
export const updateBindings = (elements: Elements): SceneElement[] => {
  const map = byId(elements);
  let changed = false;
  const next = elements.map((el) => {
    if (!isLinear(el) || (!el.startBinding && !el.endBinding)) return el;
    const start = el.startBinding ? map.get(el.startBinding.elementId) : undefined;
    const end = el.endBinding ? map.get(el.endBinding.elementId) : undefined;
    let updated: LinearElement = el;
    if (el.startBinding && !start) updated = { ...updated, startBinding: null };
    if (el.endBinding && !end) updated = { ...updated, endBinding: null };
    if (!start && !end) {
      if (updated !== el) changed = true;
      return updated;
    }
    const abs = getAbsolutePoints(el);
    const n = abs.length;
    if (n < 2) return updated;
    if (start) {
      const target = n === 2 && end ? getCenter(end) : abs[1];
      abs[0] = boundaryPoint(start, target);
    }
    if (end) {
      const target = n === 2 && start ? getCenter(start) : abs[n - 2];
      abs[n - 1] = boundaryPoint(end, target);
    }
    changed = true;
    return fromAbsolutePoints(updated, abs);
  });
  return changed ? next : (elements as SceneElement[]);
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
  const clones = source
    .filter((el) => !(el.type === "text" && el.containerId && !idMap.has(el.containerId)))
    .map((el): SceneElement => {
      const copy = structuredClone(el) as SceneElement;
      copy.id = idMap.get(el.id)!;
      copy.x += dx;
      copy.y += dy;
      copy.seed = newSeed();
      copy.locked = false;
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

/** Applies bindings and bound text layout after any geometry change. */
export const finalizeScene = (elements: Elements): SceneElement[] =>
  updateBindings(syncBoundTexts(elements));
