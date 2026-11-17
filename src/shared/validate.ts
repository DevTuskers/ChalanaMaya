/**
 * Strict stored-element validation (plan §3.11). Pure and DOM-free.
 * It only checks, it never changes: anything that is not already in canonical
 * form is refused with the field path, so the element a sender keeps is exactly
 * the element every replica stores.
 */
import type { SceneElement } from "../scene/types";
import { SESSION_FILE_PATH_RE } from "./ids";
import { normalizeLink } from "./links";
import { ID_RE, LIMITS, isColor } from "./limits";

export type ValidationResult<T> = { ok: true; el: T } | { ok: false; path: string; reason: string };

class Invalid extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (path: string, reason: string): never => {
  throw new Invalid(path, reason);
};

const num = (o: Obj, k: string, min: number, max: number, path = k) => {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "must be a finite number");
  if ((v as number) < min || (v as number) > max) fail(path, `must be between ${min} and ${max}`);
};
const bool = (o: Obj, k: string) => {
  if (typeof o[k] !== "boolean") fail(k, "must be true or false");
};
const oneOf = (o: Obj, k: string, allowed: readonly unknown[]) => {
  if (!allowed.includes(o[k])) fail(k, `must be one of ${allowed.join(", ")}`);
};
const id = (v: unknown, path: string) => {
  if (typeof v !== "string" || !ID_RE.test(v))
    fail(path, "must be an id of 1-64 letters, digits, _ or -");
};
const nullableId = (o: Obj, k: string) => {
  if (o[k] !== null) id(o[k], k);
};
const str = (o: Obj, k: string, max: number) => {
  const v = o[k];
  if (typeof v !== "string") fail(k, "must be text");
  if ((v as string).length > max) fail(k, `must be at most ${max} characters`);
};
const binding = (o: Obj, k: string) => {
  const v = o[k];
  if (v === null) return;
  if (!isObj(v)) return fail(k, "must be null or {elementId}");
  exactKeys(v, ["elementId"], [], k);
  id(v.elementId, `${k}.elementId`);
};
const exactKeys = (
  o: Obj,
  required: readonly string[],
  optional: readonly string[],
  prefix = "",
) => {
  const p = (k: string) => (prefix ? `${prefix}.${k}` : k);
  for (const k of required) if (!(k in o)) fail(p(k), "is missing");
  for (const k of Object.keys(o)) {
    if (!required.includes(k) && !optional.includes(k)) fail(p(k), "is not a known field");
  }
};

const FILL = ["hachure", "cross-hatch", "zigzag", "solid"] as const;
const STROKE = ["solid", "dashed", "dotted"] as const;
const ROUTING = ["straight", "curved", "elbow"] as const;
export const ARROWHEAD_NAMES = [
  "none",
  "arrow",
  "bar",
  "circle",
  "circle-outline",
  "triangle",
  "triangle-outline",
  "diamond",
  "diamond-outline",
  "er-zero",
  "er-one",
  "er-many",
  "er-zero-one",
  "er-zero-many",
  "er-one-many",
] as const;

const BASE_KEYS = [
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "edges",
  "opacity",
  "seed",
  "locked",
  "groupIds",
  "frameId",
  "link",
] as const;

const TYPE_KEYS: Record<string, { required: string[]; optional: string[] }> = {
  rectangle: { required: [], optional: [] },
  diamond: { required: [], optional: [] },
  ellipse: { required: [], optional: [] },
  note: { required: [], optional: [] },
  frame: { required: ["name"], optional: [] },
  arrow: {
    required: [
      "points",
      "closed",
      "startBinding",
      "endBinding",
      "routing",
      "startArrowhead",
      "endArrowhead",
    ],
    optional: [],
  },
  line: {
    required: [
      "points",
      "closed",
      "startBinding",
      "endBinding",
      "routing",
      "startArrowhead",
      "endArrowhead",
    ],
    optional: [],
  },
  freedraw: { required: ["points"], optional: ["pressures"] },
  text: {
    required: ["text", "fontFamily", "fontSize", "textAlign", "containerId", "autoWidth"],
    optional: [],
  },
  image: { required: ["fileId", "crop", "flipX", "flipY"], optional: [] },
  embed: { required: ["url"], optional: [] },
};

const points = (o: Obj, max: number) => {
  const v = o.points;
  if (!Array.isArray(v)) return fail("points", "must be a list");
  if (v.length < 1 || v.length > max) fail("points", `must have 1-${max} points`);
  v.forEach((p, i) => {
    if (!isObj(p)) return fail(`points[${i}]`, "must be {x, y}");
    exactKeys(p, ["x", "y"], [], `points[${i}]`);
    num(p, "x", -LIMITS.coord, LIMITS.coord, `points[${i}].x`);
    num(p, "y", -LIMITS.coord, LIMITS.coord, `points[${i}].y`);
  });
  return v.length;
};

const checkElement = (raw: unknown): SceneElement => {
  if (!isObj(raw)) return fail("", "an element must be an object");
  const type = raw.type;
  if (typeof type !== "string" || !(type in TYPE_KEYS))
    return fail("type", "is not a known element type");
  const spec = TYPE_KEYS[type];
  exactKeys(raw, [...BASE_KEYS, ...spec.required], spec.optional);
  id(raw.id, "id");
  num(raw, "x", -LIMITS.coord, LIMITS.coord);
  num(raw, "y", -LIMITS.coord, LIMITS.coord);
  num(raw, "width", 0, LIMITS.size);
  num(raw, "height", 0, LIMITS.size);
  num(raw, "angle", -LIMITS.angle, LIMITS.angle);
  if (!isColor(raw.strokeColor))
    fail("strokeColor", "must be a lower-case #hex colour or transparent");
  if (!isColor(raw.backgroundColor))
    fail("backgroundColor", "must be a lower-case #hex colour or transparent");
  oneOf(raw, "fillStyle", FILL);
  num(raw, "strokeWidth", 0, LIMITS.strokeWidthMax);
  oneOf(raw, "strokeStyle", STROKE);
  oneOf(raw, "roughness", [0, 1, 2]);
  oneOf(raw, "edges", ["sharp", "round"]);
  num(raw, "opacity", 0, LIMITS.opacityMax);
  num(raw, "seed", 0, LIMITS.seedMax);
  if (!Number.isInteger(raw.seed)) fail("seed", "must be a whole number");
  bool(raw, "locked");
  if (!Array.isArray(raw.groupIds)) fail("groupIds", "must be a list");
  const groups = raw.groupIds as unknown[];
  if (groups.length > LIMITS.groupIds)
    fail("groupIds", `must have at most ${LIMITS.groupIds} entries`);
  groups.forEach((g, i) => id(g, `groupIds[${i}]`));
  nullableId(raw, "frameId");
  if (raw.link !== null) {
    str(raw, "link", LIMITS.link);
    if (normalizeLink(raw.link as string) !== raw.link)
      fail("link", "must be a canonical http(s), mailto or #el= link");
  }
  switch (type) {
    case "frame":
      str(raw, "name", LIMITS.frameName);
      break;
    case "arrow":
    case "line":
      points(raw, LIMITS.linearPoints);
      bool(raw, "closed");
      binding(raw, "startBinding");
      binding(raw, "endBinding");
      oneOf(raw, "routing", ROUTING);
      oneOf(raw, "startArrowhead", ARROWHEAD_NAMES);
      oneOf(raw, "endArrowhead", ARROWHEAD_NAMES);
      break;
    case "freedraw": {
      const n = points(raw, LIMITS.freedrawPoints);
      if ("pressures" in raw && raw.pressures !== null) {
        const pr = raw.pressures;
        if (!Array.isArray(pr) || pr.length !== n)
          fail("pressures", "must be null or one number per point");
        (pr as unknown[]).forEach((v, i) => {
          if (typeof v !== "number" || !(v >= 0 && v <= 1)) fail(`pressures[${i}]`, "must be 0-1");
        });
      }
      break;
    }
    case "text":
      str(raw, "text", LIMITS.textChars);
      oneOf(raw, "fontFamily", ["hand", "normal", "code"]);
      num(raw, "fontSize", LIMITS.fontSizeMin, LIMITS.fontSizeMax);
      oneOf(raw, "textAlign", ["left", "center", "right"]);
      nullableId(raw, "containerId");
      bool(raw, "autoWidth");
      break;
    case "image": {
      id(raw.fileId, "fileId");
      const c = raw.crop;
      if (c !== null) {
        if (!isObj(c)) return fail("crop", "must be null or a crop box");
        const keys = ["x", "y", "width", "height", "naturalWidth", "naturalHeight"];
        exactKeys(c, keys, [], "crop");
        for (const k of keys) num(c, k, 0, LIMITS.size, `crop.${k}`);
        if (!((c.width as number) > 0 && (c.height as number) > 0))
          fail("crop", "must have a positive width and height");
      }
      bool(raw, "flipX");
      bool(raw, "flipY");
      break;
    }
    case "embed": {
      str(raw, "url", LIMITS.url);
      let ok = false;
      try {
        const u = new URL(raw.url as string);
        ok = u.protocol === "https:" || u.protocol === "http:";
      } catch {
        ok = false;
      }
      if (!ok) fail("url", "must be an http(s) address");
      break;
    }
  }
  return raw as unknown as SceneElement;
};

export const validateStoredElement = (raw: unknown): ValidationResult<SceneElement> => {
  try {
    const el = checkElement(raw);
    if (JSON.stringify(el).length > LIMITS.elementBytes)
      return { ok: false, path: "", reason: "element_too_large" };
    return { ok: true, el };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, path: e.path, reason: e.reason };
    throw e;
  }
};

export interface SessionSettings {
  viewBackgroundColor?: string;
  gridEnabled?: boolean;
  title?: string;
}

export const validateSettings = (raw: unknown): ValidationResult<SessionSettings> => {
  try {
    if (!isObj(raw)) return fail("", "settings must be an object");
    exactKeys(raw, [], ["viewBackgroundColor", "gridEnabled", "title"]);
    if ("viewBackgroundColor" in raw && !isColor(raw.viewBackgroundColor))
      fail("viewBackgroundColor", "must be a lower-case #hex colour or transparent");
    if ("gridEnabled" in raw) bool(raw, "gridEnabled");
    if ("title" in raw) {
      str(raw, "title", LIMITS.title);
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(raw.title as string))
        fail("title", "must not contain control characters");
    }
    return { ok: true, el: raw as SessionSettings };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, path: e.path, reason: e.reason };
    throw e;
  }
};

export const ALLOWED_MIME = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
] as const;

export interface FileMeta {
  id: string;
  mime: string;
  url: string;
}

/** File rows: id rule, allowed type, same-origin file path (remote links arrive in phase 5). */
export const validateFileMeta = (raw: unknown): ValidationResult<FileMeta> => {
  try {
    if (!isObj(raw)) return fail("", "a file must be an object");
    id(raw.id, "id");
    oneOf(raw, "mime", ALLOWED_MIME);
    if (typeof raw.url !== "string" || !SESSION_FILE_PATH_RE.test(raw.url))
      fail("url", "must be this server's /api/sessions/<id>/files/<fileId> path");
    return { ok: true, el: raw as unknown as FileMeta };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, path: e.path, reason: e.reason };
    throw e;
  }
};
