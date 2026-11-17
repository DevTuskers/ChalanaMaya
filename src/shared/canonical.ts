/**
 * Canonicalisation for lenient edges only: opening/importing `.chalana` files
 * and local recovery (plan §3.11). The output always goes through strict
 * validation afterwards; elements that still fail are dropped and reported.
 */
import type { FreedrawElement, SceneElement } from "../scene/types";
import { ID_RE, LIMITS, isColor, wrapAngle } from "./limits";
import { normalizeLink } from "./links";
import { validateStoredElement } from "./validate";

export interface CanonicalReport {
  /** Human-readable notes, one per change, e.g. "abc: strokeColor reset". */
  changes: string[];
  /** Elements that could not be made valid. */
  dropped: { id: string; path: string; reason: string }[];
}

let counter = 0;
const freshId = () => {
  counter += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `${rand}${counter.toString(36)}`;
};

const clampNum = (v: number, min: number, max: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;

const canonColor = (v: string, fallback: string) => {
  const lower = typeof v === "string" ? v.trim().toLowerCase() : "";
  return isColor(lower) ? lower : fallback;
};

/** Splits a freedraw stroke into consecutive strokes of at most `max` points. */
export const splitFreedraw = (
  el: FreedrawElement,
  max = LIMITS.freedrawPoints,
): FreedrawElement[] => {
  if (el.points.length <= max) return [el];
  const out: FreedrawElement[] = [];
  for (let start = 0; start < el.points.length - 1; start += max - 1) {
    const slice = el.points.slice(start, start + max);
    const pr = el.pressures ? el.pressures.slice(start, start + max) : undefined;
    const xs = slice.map((p) => p.x + el.x);
    const ys = slice.map((p) => p.y + el.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const part: FreedrawElement = {
      ...el,
      id: out.length === 0 ? el.id : freshId(),
      x: minX,
      y: minY,
      width: Math.max(...xs) - minX,
      height: Math.max(...ys) - minY,
      points: slice.map((p) => ({ x: p.x + el.x - minX, y: p.y + el.y - minY })),
    };
    if (pr) part.pressures = pr;
    else delete part.pressures;
    out.push(part);
  }
  return out;
};

/**
 * Turns parser output into canonical elements: lower-case colours, wrapped
 * angles, valid ids (references remapped), trimmed texts and names, split
 * long strokes, then strict validation on each element.
 */
export const canonicalizeElements = (
  input: readonly SceneElement[],
): { elements: SceneElement[]; report: CanonicalReport } => {
  const report: CanonicalReport = { changes: [], dropped: [] };
  const remap = new Map<string, string>();
  const seen = new Set<string>();
  for (const el of input) {
    if (typeof el.id !== "string" || !ID_RE.test(el.id) || seen.has(el.id)) {
      const next = freshId();
      remap.set(el.id, next);
      report.changes.push(`${String(el.id).slice(0, 40)}: id replaced with ${next}`);
      seen.add(next);
    } else seen.add(el.id);
  }
  const ref = (v: string | null | undefined) => {
    if (v == null) return null;
    const r = remap.get(v) ?? v;
    return ID_RE.test(r) ? r : null;
  };
  const used = new Set<string>();
  const out: SceneElement[] = [];
  for (const original of input) {
    let id = original.id;
    if (remap.has(id) && !used.has(`remap:${id}`)) {
      used.add(`remap:${id}`);
      id = remap.get(id)!;
    } else if (used.has(id)) id = freshId();
    used.add(id);
    const note = (what: string) => report.changes.push(`${id}: ${what}`);
    const el = { ...original, id } as SceneElement & Record<string, unknown>;
    const stroke = canonColor(el.strokeColor, "#193a36");
    if (stroke !== el.strokeColor) note("strokeColor reset");
    el.strokeColor = stroke;
    const bg = canonColor(el.backgroundColor, "transparent");
    if (bg !== el.backgroundColor) note("backgroundColor reset");
    el.backgroundColor = bg;
    const angle = wrapAngle(Number.isFinite(el.angle) ? el.angle : 0);
    if (angle !== el.angle) note("angle wrapped");
    el.angle = angle;
    el.x = clampNum(el.x, -LIMITS.coord, LIMITS.coord);
    el.y = clampNum(el.y, -LIMITS.coord, LIMITS.coord);
    el.width = clampNum(el.width, 0, LIMITS.size);
    el.height = clampNum(el.height, 0, LIMITS.size);
    el.strokeWidth = clampNum(el.strokeWidth, 0, LIMITS.strokeWidthMax);
    el.seed = Math.floor(clampNum(el.seed, 0, LIMITS.seedMax - 1));
    const groups = el.groupIds.map((g) => ref(g)).filter((g): g is string => !!g);
    el.groupIds = groups.slice(0, LIMITS.groupIds);
    el.frameId = ref(el.frameId);
    if (el.link !== null) {
      const link = el.link.length <= LIMITS.link ? normalizeLink(el.link) : null;
      if (link !== el.link) note("link removed");
      el.link = link;
    }
    if (el.type === "text") {
      if (el.text.length > LIMITS.textChars) {
        el.text = el.text.slice(0, LIMITS.textChars);
        note("text truncated");
      }
      el.containerId = ref(el.containerId);
      el.fontSize = clampNum(el.fontSize, LIMITS.fontSizeMin, LIMITS.fontSizeMax);
    }
    if (el.type === "frame" && el.name.length > LIMITS.frameName) {
      el.name = el.name.slice(0, LIMITS.frameName);
      note("frame name truncated");
    }
    if (el.type === "image") el.fileId = ref(el.fileId) ?? el.fileId;
    if (el.type === "arrow" || el.type === "line") {
      const s = el.startBinding && ref(el.startBinding.elementId);
      const e = el.endBinding && ref(el.endBinding.elementId);
      el.startBinding = s ? { elementId: s } : null;
      el.endBinding = e ? { elementId: e } : null;
      if (el.points.length > LIMITS.linearPoints) {
        el.points = el.points.slice(0, LIMITS.linearPoints);
        note("points trimmed");
      }
    }
    const parts = el.type === "freedraw" ? splitFreedraw(el as FreedrawElement) : [el];
    if (parts.length > 1) note(`stroke split into ${parts.length} strokes`);
    for (const part of parts) {
      const r = validateStoredElement(part);
      if (r.ok) out.push(r.el);
      else report.dropped.push({ id: part.id, path: r.path, reason: r.reason });
    }
  }
  return { elements: out, report };
};
