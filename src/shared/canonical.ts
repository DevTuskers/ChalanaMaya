/**
 * Canonicalisation for lenient edges only: opening/importing `.chalana` files
 * and local recovery (plan §3.11). The output always goes through strict
 * validation afterwards; elements that still fail are dropped and reported.
 */
import type { FreedrawElement, SceneElement } from "../scene/types";
import { ID_RE, LIMITS, freedrawSourcePoints, isColor, wrapAngle } from "./limits";
import { normalizeLink } from "./links";
import { ARROWHEAD_NAMES, validateStoredElement } from "./validate";

let counter = 0;
const freshId = () => {
  counter += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `${rand}${counter.toString(36)}`;
};

const canonColor = (v: string, fallback: string) => {
  const lower = typeof v === "string" ? v.trim().toLowerCase() : "";
  return isColor(lower) ? lower : fallback;
};

/**
 * Splits a freedraw stroke into consecutive strokes of at most `max` points.
 * The default cap is the size-aware source cap, so every part also fits the
 * element byte cap whatever its coordinates and pressures.
 */
export const splitFreedraw = (
  el: FreedrawElement,
  max = freedrawSourcePoints(Array.isArray(el.pressures)),
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

type ChangeKind =
  | "colour reset"
  | "colour tidied"
  | "angle wrapped"
  | "id replaced"
  | "number fixed"
  | "option reset"
  | "link removed"
  | "text shortened"
  | "path shortened"
  | "stroke split"
  | "pressure fixed"
  | "reference removed";

const PHRASES: Record<ChangeKind, [string, string]> = {
  "colour reset": ["colour was reset", "colours were reset"],
  "colour tidied": ["colour was tidied", "colours were tidied"],
  "angle wrapped": ["angle was wrapped", "angles were wrapped"],
  "id replaced": ["id was replaced", "ids were replaced"],
  "number fixed": ["number was brought into range", "numbers were brought into range"],
  "option reset": ["style option was reset", "style options were reset"],
  "link removed": ["link was removed", "links were removed"],
  "text shortened": ["text was shortened", "texts were shortened"],
  "path shortened": ["path was shortened", "paths were shortened"],
  "stroke split": ["long stroke was split", "long strokes were split"],
  "pressure fixed": ["pen pressure was fixed", "pen pressures were fixed"],
  "reference removed": ["broken reference was removed", "broken references were removed"],
};

export interface CanonicalReport {
  /** Human-readable notes, one per change, e.g. "abc: strokeColor reset". */
  changes: string[];
  /** How many changes of each kind were made (for the summary toast). */
  counts: Partial<Record<ChangeKind, number>>;
  /** Elements that could not be made valid. */
  dropped: { id: string; type: string; path: string; reason: string }[];
}

/** One sentence that says what was changed, e.g. "3 colours were reset." */
export const summarizeReport = (report: CanonicalReport): string => {
  const parts = (Object.keys(report.counts) as ChangeKind[]).map((k) => {
    const n = report.counts[k] ?? 0;
    return `${n} ${PHRASES[k][n === 1 ? 0 : 1]}`;
  });
  const d = report.dropped;
  if (d.length) {
    const named = d
      .slice(0, 3)
      .map((x) => `${x.type} ${x.id.slice(0, 12)}${x.path ? ` (${x.path})` : ""}`)
      .join(", ");
    const more = d.length > 3 ? ` and ${d.length - 3} more` : "";
    parts.push(
      `${d.length} unreadable item${d.length === 1 ? " was" : "s were"} skipped: ${named}${more}`,
    );
  }
  if (!parts.length) return "";
  const text = parts.join("; ");
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
};

type Loose = Record<string, unknown>;

const FILL = ["hachure", "cross-hatch", "zigzag", "solid"];
const STROKE = ["solid", "dashed", "dotted"];
const ROUTING = ["straight", "curved", "elbow"];

/**
 * Turns parsed elements into canonical ones. It is self-sufficient: colours,
 * numbers (non-finite values get the default, others are clamped), enums,
 * booleans, pressures, ids (references remapped), texts, names and long
 * strokes are all fixed here, then every element is strictly validated.
 * Each change is reported; elements that still fail are dropped and reported.
 */
export const canonicalizeElements = (
  input: readonly SceneElement[],
): { elements: SceneElement[]; report: CanonicalReport } => {
  const report: CanonicalReport = { changes: [], counts: {}, dropped: [] };
  const record = (id: string, kind: ChangeKind, what: string) => {
    report.changes.push(`${id}: ${what}`);
    report.counts[kind] = (report.counts[kind] ?? 0) + 1;
  };

  // ids by position: the first holder of a valid id keeps it, everything else
  // gets a fresh one; references to an invalid id follow its first holder
  const remap = new Map<string, string>();
  const seen = new Set<string>();
  const ids = input.map((el) => {
    const raw: unknown = el.id;
    if (typeof raw === "string" && ID_RE.test(raw) && !seen.has(raw)) {
      seen.add(raw);
      return raw;
    }
    const next = freshId();
    seen.add(next);
    if (typeof raw === "string" && !ID_RE.test(raw) && !remap.has(raw)) remap.set(raw, next);
    record(next, "id replaced", `id ${String(raw).slice(0, 40)} replaced`);
    return next;
  });
  const ref = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const r = remap.get(v) ?? v;
    return ID_RE.test(r) ? r : null;
  };
  // group ids are not element ids: invalid ones map consistently to fresh ones
  const groupRemap = new Map<string, string>();
  const groupRef = (g: unknown): string | null => {
    if (typeof g !== "string") return null;
    if (ID_RE.test(g)) return g;
    let next = groupRemap.get(g);
    if (!next) {
      next = freshId();
      groupRemap.set(g, next);
    }
    return next;
  };

  const out: SceneElement[] = [];
  input.forEach((original, index) => {
    const id = ids[index];
    const el: Loose = { ...(original as unknown as Loose), id };
    const note = (kind: ChangeKind, what: string) => record(id, kind, what);

    const numField = (k: string, min: number, max: number, def: number, int = false) => {
      const v = el[k];
      let next: number;
      if (typeof v !== "number" || !Number.isFinite(v)) next = def;
      else next = Math.min(max, Math.max(min, int ? Math.floor(v) : v));
      if (next !== v) note("number fixed", `${k} set to ${next}`);
      el[k] = next;
    };
    const enumField = (k: string, allowed: readonly unknown[], def: unknown) => {
      if (!allowed.includes(el[k])) {
        note("option reset", `${k} reset`);
        el[k] = def;
      }
    };
    const boolField = (k: string, def = false) => {
      if (typeof el[k] !== "boolean") {
        note("option reset", `${k} reset`);
        el[k] = def;
      }
    };
    const colorField = (k: string, def: string) => {
      const v = el[k];
      const next = canonColor(v as string, def);
      if (next !== v) {
        const tidied = typeof v === "string" && next === v.trim().toLowerCase();
        note(tidied ? "colour tidied" : "colour reset", `${k} ${tidied ? "tidied" : "reset"}`);
      }
      el[k] = next;
    };
    const refField = (k: string) => {
      const v = el[k];
      const next = v == null ? null : ref(v);
      if (next !== v) {
        if (next === null) note("reference removed", `${k} removed`);
        else report.changes.push(`${id}: ${k} remapped`);
      }
      el[k] = next;
    };

    colorField("strokeColor", "#193a36");
    colorField("backgroundColor", "transparent");
    const a = el.angle;
    const angle = wrapAngle(typeof a === "number" && Number.isFinite(a) ? a : 0);
    if (angle !== a) note("angle wrapped", "angle wrapped");
    el.angle = angle;
    numField("x", -LIMITS.coord, LIMITS.coord, 0);
    numField("y", -LIMITS.coord, LIMITS.coord, 0);
    numField("width", 0, LIMITS.size, 0);
    numField("height", 0, LIMITS.size, 0);
    numField("strokeWidth", 0, LIMITS.strokeWidthMax, 2.5);
    numField("opacity", 0, LIMITS.opacityMax, 100);
    numField("seed", 0, LIMITS.seedMax - 1, 1, true);
    enumField("fillStyle", FILL, "hachure");
    enumField("strokeStyle", STROKE, "solid");
    enumField("roughness", [0, 1, 2], 1);
    enumField("edges", ["sharp", "round"], "sharp");
    boolField("locked");

    const rawGroups = Array.isArray(el.groupIds) ? (el.groupIds as unknown[]) : [];
    const groups = rawGroups.map(groupRef).filter((g): g is string => !!g);
    if (groups.length > LIMITS.groupIds) note("reference removed", "groupIds trimmed");
    el.groupIds = groups.slice(0, LIMITS.groupIds);
    refField("frameId");
    if (el.link !== null) {
      const raw = el.link;
      const link = typeof raw === "string" && raw.length <= LIMITS.link ? normalizeLink(raw) : null;
      if (link !== raw) note("link removed", "link removed");
      el.link = link;
    }

    switch (el.type) {
      case "text": {
        const text = typeof el.text === "string" ? el.text : "";
        if (text.length > LIMITS.textChars) note("text shortened", "text truncated");
        el.text = text.slice(0, LIMITS.textChars);
        refField("containerId");
        numField("fontSize", LIMITS.fontSizeMin, LIMITS.fontSizeMax, 20);
        enumField("fontFamily", ["hand", "normal", "code"], "hand");
        enumField("textAlign", ["left", "center", "right"], "left");
        boolField("autoWidth", true);
        break;
      }
      case "frame": {
        const name = typeof el.name === "string" ? el.name : "";
        if (name.length > LIMITS.frameName) note("text shortened", "frame name truncated");
        el.name = name.slice(0, LIMITS.frameName);
        break;
      }
      case "image":
        // the file id names a picture in the file map, not an element: never remapped
        boolField("flipX");
        boolField("flipY");
        break;
      case "arrow":
      case "line": {
        for (const k of ["startBinding", "endBinding"] as const) {
          const b = el[k] as { elementId?: unknown } | null | undefined;
          const target = b && typeof b === "object" ? ref(b.elementId) : null;
          if (b && !target) note("reference removed", `${k} removed`);
          el[k] = target ? { elementId: target } : null;
        }
        enumField("routing", ROUTING, "straight");
        enumField("startArrowhead", ARROWHEAD_NAMES, "none");
        enumField("endArrowhead", ARROWHEAD_NAMES, el.type === "arrow" ? "arrow" : "none");
        boolField("closed");
        const pts = el.points as unknown[];
        if (Array.isArray(pts) && pts.length > LIMITS.linearPoints) {
          el.points = pts.slice(0, LIMITS.linearPoints);
          note("path shortened", "points trimmed");
        }
        break;
      }
      case "freedraw": {
        const pts = Array.isArray(el.points) ? (el.points as unknown[]) : [];
        if ("pressures" in el && el.pressures !== null) {
          const pr = el.pressures;
          if (!Array.isArray(pr) || pr.length !== pts.length) {
            note("pressure fixed", "pressures removed");
            el.pressures = null;
          } else {
            const fixed = pr.map((v: unknown) =>
              typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1,
            );
            if (fixed.some((v, i) => v !== pr[i])) note("pressure fixed", "pressures clamped");
            el.pressures = fixed;
          }
        }
        break;
      }
    }

    let parts: Loose[] = [el];
    if (el.type === "freedraw") {
      const fd = el as unknown as FreedrawElement;
      // split by point count and by serialised size, so no drawing is lost
      if (
        fd.points.length > LIMITS.freedrawPoints ||
        JSON.stringify(fd).length > LIMITS.elementBytes
      ) {
        parts = splitFreedraw(fd) as unknown as Loose[];
        if (parts.length > 1) note("stroke split", `stroke split into ${parts.length} strokes`);
      }
    }
    for (const part of parts) {
      const r = validateStoredElement(part);
      if (r.ok) out.push(r.el);
      else
        report.dropped.push({
          id: String(part.id),
          type: String(part.type),
          path: r.path,
          reason: r.reason,
        });
    }
  });
  return { elements: out, report };
};
